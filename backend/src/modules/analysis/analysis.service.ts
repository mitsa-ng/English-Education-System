import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AnalysisResult, Attachment, Submission } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { FILE_STORAGE } from '../../infrastructure/storage/storage.module';
import type { FileStorage } from '../../infrastructure/storage/file-storage.interface';
import {
  ANALYSIS_ENGINE,
  AnalysisEngineUnavailableError,
  type AnalysisEngine,
  type AnalysisOutput,
} from '../../infrastructure/analyzer-client/analysis-engine.interface';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { TriggerAnalysisDto } from './dto/trigger-analysis.dto';

/** 同時進行中的分析上限（docs/analysis-service.md：單實例單教師量體）。 */
const MAX_CONCURRENT = 3;

interface SubmissionContext {
  submission: Submission & { attachments: Attachment[]; assignment: { class: { teacherId: string } }; student: { userId: string } };
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private running = 0;
  private readonly queue: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ANALYSIS_ENGINE) private readonly engine: AnalysisEngine,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** 觸發分析：建立 PENDING 紀錄 → 202，實際執行由內部 worker 非同步處理。 */
  async trigger(user: AuthenticatedUser, submissionId: string, dto: TriggerAnalysisDto) {
    const ctx = await this.loadAccessibleSubmission(user, submissionId);

    const hasContent = Boolean(ctx.submission.content?.trim());
    const hasFile = ctx.submission.attachments.length > 0;
    if (dto.inputSource === 'content' && !hasContent && !hasFile) {
      throw AppException.unprocessable(
        ErrorCode.ANALYSIS_NO_CONTENT,
        '提交沒有可分析的內容',
        { submissionId },
      );
    }
    if (dto.inputSource === 'latestFile' && !hasFile) {
      throw AppException.unprocessable(
        ErrorCode.ANALYSIS_NO_CONTENT,
        '提交沒有可分析的檔案',
        { submissionId },
      );
    }

    const running = await this.prisma.analysisResult.count({
      where: { submissionId, status: { in: ['PENDING', 'PROCESSING'] } },
    });
    if (running > 0) {
      throw AppException.conflict(ErrorCode.ANALYSIS_ALREADY_RUNNING, '此提交已有分析進行中', {
        submissionId,
      });
    }

    const record = await this.prisma.analysisResult.create({
      data: {
        submissionId,
        requestedByUserId: user.userId,
        language: dto.language,
        status: 'PENDING',
      },
    });

    this.enqueue(record.id, dto.inputSource);
    return this.toSummary(record);
  }

  async getLatest(user: AuthenticatedUser, submissionId: string, includeAll: boolean) {
    await this.loadAccessibleSubmission(user, submissionId);
    const rows = await this.prisma.analysisResult.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'desc' },
      take: includeAll ? 20 : 1,
    });
    if (rows.length === 0) {
      throw AppException.notFound(ErrorCode.ANALYSIS_NOT_FOUND, '尚無分析結果', { submissionId });
    }
    const details = [];
    for (const row of rows) {
      details.push(await this.toDetail(row));
    }
    return includeAll ? { data: details } : details[0];
  }

  // ── worker（in-process queue，並發上限 MAX_CONCURRENT） ────────────────

  private enqueue(resultId: string, inputSource: 'content' | 'latestFile'): void {
    this.queue.push(resultId);
    void this.pump(inputSource);
  }

  private async pump(inputSource: 'content' | 'latestFile'): Promise<void> {
    if (this.running >= MAX_CONCURRENT) {
      return;
    }
    const resultId = this.queue.shift();
    if (!resultId) {
      return;
    }
    this.running += 1;
    try {
      await this.execute(resultId, inputSource);
    } finally {
      this.running -= 1;
      if (this.queue.length > 0) {
        void this.pump(inputSource);
      }
    }
  }

  private async execute(resultId: string, inputSource: 'content' | 'latestFile'): Promise<void> {
    const record = await this.prisma.analysisResult.findUnique({
      where: { id: resultId },
      include: {
        submission: {
          include: {
            attachments: { orderBy: { createdAt: 'desc' } },
            assignment: { include: { class: true } },
            student: true,
          },
        },
      },
    });
    if (!record || record.status !== 'PENDING') {
      return;
    }

    await this.prisma.analysisResult.update({
      where: { id: resultId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    try {
      let output: AnalysisOutput;
      let annotatedPdfKey: string | null = null;

      const useFile =
        inputSource === 'latestFile' ||
        (inputSource === 'content' && !record.submission.content?.trim() && record.submission.attachments.length > 0);

      if (useFile) {
        const attachment = record.submission.attachments[0];
        const data = await this.storage.getObject(attachment.storageKey);
        const fileOutput = await this.engine.analyzeFile({
          data,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          language: record.language,
        });
        output = fileOutput;
        if (fileOutput.annotatedPdfBase64) {
          annotatedPdfKey = `analysis/${resultId}/annotated.pdf`;
          await this.storage.putObject(
            annotatedPdfKey,
            Buffer.from(fileOutput.annotatedPdfBase64, 'base64'),
            'application/pdf',
          );
        }
      } else {
        output = await this.engine.analyzeText({
          text: record.submission.content ?? '',
          language: record.language,
        });
      }

      await this.prisma.analysisResult.update({
        where: { id: resultId },
        data: {
          status: 'COMPLETED',
          resultJson: { errors: output.errors, summary: output.summary } as object,
          engineVersion: output.engineVersion,
          annotatedPdfKey,
          completedAt: new Date(),
        },
      });
      this.logger.log(`analysis ${resultId} COMPLETED（${output.errors.length} errors）`);
    } catch (error) {
      const { code, message } = this.mapEngineError(error);
      await this.prisma.analysisResult.update({
        where: { id: resultId },
        data: {
          status: 'FAILED',
          errorCode: code,
          errorMessage: message,
          completedAt: new Date(),
        },
      });
      this.logger.warn(`analysis ${resultId} FAILED：${code} — ${message}`);
    }
  }

  private mapEngineError(error: unknown): { code: string; message: string } {
    if (error instanceof AnalysisEngineUnavailableError) {
      return { code: ErrorCode.ANALYSIS_ENGINE_UNAVAILABLE, message: error.message };
    }
    const anyError = error as { status?: number; code?: string; message?: string };
    if (anyError?.code === 'ANALYZER_OCR_NO_TEXT') {
      return { code: ErrorCode.ANALYSIS_OCR_FAILED, message: 'OCR 無法抽出文字' };
    }
    if (anyError?.code === 'ANALYZER_INVALID_LANGUAGE') {
      return { code: ErrorCode.ANALYSIS_FAILED, message: `不支援的語言：${anyError.message ?? ''}` };
    }
    return {
      code: ErrorCode.ANALYSIS_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // ── 存取與 DTO ──────────────────────────────────────────────────────────

  private async loadAccessibleSubmission(user: AuthenticatedUser, submissionId: string): Promise<SubmissionContext> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        attachments: true,
        assignment: { include: { class: true } },
        student: true,
      },
    });
    if (!submission) {
      throw AppException.notFound(ErrorCode.SUBMISSION_NOT_FOUND, '找不到該提交', { submissionId });
    }
    if (user.role === 'STUDENT' && submission.student.userId !== user.userId) {
      throw AppException.forbidden('僅能分析自己的提交', { submissionId });
    }
    if (user.role === 'TEACHER' && submission.assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('無權分析此提交', { submissionId });
    }
    return { submission: submission as SubmissionContext['submission'] };
  }

  private toSummary(record: AnalysisResult) {
    return {
      id: record.id,
      submissionId: record.submissionId,
      status: record.status,
      language: record.language,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
      createdAt: record.createdAt,
      completedAt: record.completedAt?.toISOString() ?? null,
    };
  }

  private async toDetail(record: AnalysisResult) {
    const result = (record.resultJson ?? null) as
      | { errors: unknown[]; summary: Record<string, number> }
      | null;
    let annotatedPdfAttachmentId: string | null = null;
    if (record.annotatedPdfKey) {
      const attachment = await this.prisma.attachment.findUnique({
        where: { storageKey: record.annotatedPdfKey },
        select: { id: true },
      });
      annotatedPdfAttachmentId = attachment?.id ?? null;
      if (!attachment) {
        // 標註 PDF 尚未有 Attachment 列（觸發者下載用）→ 補建
        const created = await this.prisma.attachment.create({
          data: {
            storageKey: record.annotatedPdfKey,
            filename: 'annotated.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 0,
            uploadedByUserId: record.requestedByUserId,
          },
        });
        annotatedPdfAttachmentId = created.id;
      }
    }
    return {
      ...this.toSummary(record),
      result: result
        ? { errors: result.errors, summary: result.summary }
        : null,
      annotatedPdfAttachmentId,
    };
  }
}
