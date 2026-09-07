import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { FILE_STORAGE } from '../../infrastructure/storage/storage.module';
import type { FileStorage } from '../../infrastructure/storage/file-storage.interface';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { UploadRequestDto } from './dto/upload-request.dto';

/** 副檔名白名單（openapi.yaml /v1/uploads 說明）。 */
const ALLOWED_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx']);
const PUT_URL_TTL_SEC = 600;

/** 檔名 sanitization：去路徑、限字元、長度上限。 */
function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
  return cleaned.slice(0, 120) || 'file';
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async createUpload(user: AuthenticatedUser, dto: UploadRequestDto) {
    const ext = dto.filename.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw AppException.badRequest(ErrorCode.ATTACHMENT_REJECTED, '不支援的檔案類型', {
        allowedExtensions: [...ALLOWED_EXTENSIONS],
      });
    }
    if (dto.assignmentId && dto.submissionId) {
      throw AppException.badRequest(ErrorCode.ATTACHMENT_REJECTED, 'assignmentId 與 submissionId 只能擇一');
    }
    if (!dto.assignmentId && !dto.submissionId) {
      throw AppException.badRequest(ErrorCode.ATTACHMENT_REJECTED, '須指定 assignmentId 或 submissionId');
    }

    // 擁有權：assignment → 教師（說明附件）或已選課學生（提交附件）；submission → 提交者本人或教師
    if (dto.assignmentId) {
      await this.assertCanAttachToAssignment(user, dto.assignmentId);
    }
    if (dto.submissionId) {
      await this.assertCanAttachToSubmission(user, dto.submissionId);
    }

    const storageKey = `attachments/${randomUUID()}/${sanitizeFilename(dto.filename)}`;
    const attachment = await this.prisma.attachment.create({
      data: {
        storageKey,
        filename: sanitizeFilename(dto.filename),
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        uploadedByUserId: user.userId,
        assignmentId: dto.assignmentId ?? null,
        submissionId: dto.submissionId ?? null,
      },
    });

    const presigned = await this.storage.presignPut(storageKey, PUT_URL_TTL_SEC);
    return {
      attachmentId: attachment.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt,
    };
  }

  async getDownloadUrl(user: AuthenticatedUser, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        assignment: { include: { class: true } },
        submission: { include: { assignment: { include: { class: true } }, student: true } },
      },
    });
    if (!attachment) {
      throw AppException.notFound(ErrorCode.ATTACHMENT_NOT_FOUND, '找不到該附件', { attachmentId });
    }
    await this.assertCanViewAttachment(user, attachment);

    const presigned = await this.storage.presignGet(attachment.storageKey, 600);
    return { downloadUrl: presigned.url, expiresAt: presigned.expiresAt };
  }

  private async assertCanAttachToAssignment(user: AuthenticatedUser, assignmentId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment || assignment.archivedAt) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', { assignmentId });
    }
    if (user.role === 'TEACHER') {
      if (assignment.class.teacherId !== user.userId) {
        throw AppException.forbidden('無權存取此作業', { assignmentId });
      }
      return;
    }
    if (user.role === 'ASSISTANT') {
      throw AppException.forbidden('助教不可上傳附件', { assignmentId });
    }
    // 學生：已選課且作業開放中
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    const enrolled = await this.prisma.classEnrollment.findUnique({
      where: {
        classId_studentId: { classId: assignment.classId, studentId: student?.id ?? 'none' },
      },
    });
    if (enrolled?.status !== 'ACTIVE') {
      throw AppException.forbidden('未加入此班級', { assignmentId });
    }
    if (assignment.status !== 'PUBLISHED') {
      throw AppException.conflict(ErrorCode.SUBMISSION_NOT_ACCEPTABLE, '作業未開放提交', {
        assignmentStatus: assignment.status,
      });
    }
  }

  private async assertCanAttachToSubmission(user: AuthenticatedUser, submissionId: string) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { assignment: { include: { class: true } }, student: true },
    });
    if (!submission) {
      throw AppException.notFound(ErrorCode.SUBMISSION_NOT_FOUND, '找不到該提交', { submissionId });
    }
    if (user.role === 'STUDENT' && submission.student.userId !== user.userId) {
      throw AppException.forbidden('僅能上傳到自己的提交', { submissionId });
    }
    if (user.role === 'TEACHER' && submission.assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('無權存取此提交', { submissionId });
    }
  }

  private async assertCanViewAttachment(
    user: AuthenticatedUser,
    attachment: {
      assignment: { class: { teacherId: string; id: string } } | null;
      submission: {
        student: { userId: string };
        assignment: { class: { teacherId: string; id: string } };
      } | null;
      uploadedByUserId: string;
    },
  ) {
    if (user.role === 'ASSISTANT') return;
    if (user.userId === attachment.uploadedByUserId) return;

    const classTeacherId = attachment.assignment?.class.teacherId
      ?? attachment.submission?.assignment.class.teacherId;
    const classId = attachment.assignment?.class.id ?? attachment.submission?.assignment.class.id;

    if (user.role === 'TEACHER') {
      if (classTeacherId !== user.userId) {
        throw AppException.forbidden('無權存取此附件', {});
      }
      return;
    }
    // 學生：自己的提交，或已選課班級的作業說明附件
    if (attachment.submission && attachment.submission.student.userId === user.userId) return;
    if (classId) {
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      const enrolled = await this.prisma.classEnrollment.findUnique({
        where: { classId_studentId: { classId, studentId: student?.id ?? 'none' } },
      });
      if (enrolled?.status === 'ACTIVE') return;
    }
    throw AppException.forbidden('無權存取此附件', {});
  }
}
