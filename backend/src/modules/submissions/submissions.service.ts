import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { buildPageResult, toSkipTake, type PageResult } from '../../common/types/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import type { GradeSubmissionDto } from './dto/grade-submission.dto';
import type { ListSubmissionsQueryDto } from './dto/list-submissions-query.dto';
import type { SubmitAssignmentDto } from './dto/submit-assignment.dto';

const submissionInclude = {
  attachments: true,
  analysisResults: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.SubmissionInclude;

type SubmissionWithRelations = Prisma.SubmissionGetPayload<{ include: typeof submissionInclude }>;

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 學生提交／重新提交（upsert：同作業同人一列）。 */
  async submit(
    user: AuthenticatedUser,
    assignmentId: string,
    dto: SubmitAssignmentDto,
  ): Promise<Record<string, unknown>> {
    const student = await this.resolveEnrolledStudent(user, assignmentId);

    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment || assignment.archivedAt) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', { assignmentId });
    }
    if (assignment.status !== 'PUBLISHED') {
      throw this.notAcceptable(`作業未開放提交（${assignment.status}）`, { assignmentStatus: assignment.status });
    }

    const existing = await this.prisma.submission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
      include: { attachments: { select: { id: true } } },
    });
    if (existing?.status === 'RETURNED') {
      throw this.notAcceptable('此提交已發還定案，不可再修改', {});
    }
    if (existing?.status === 'GRADED') {
      throw this.notAcceptable('已評分的提交不可再修改', {});
    }
    const keepsAttachments = (existing?.attachments.length ?? 0) > 0 && dto.newAttachmentIds === undefined;
    const hasNew = Boolean(dto.content) || (dto.newAttachmentIds?.length ?? 0) > 0;
    if (!hasNew && !keepsAttachments && !existing?.content) {
      throw AppException.badRequest(
        ErrorCode.COMMON_VALIDATION_FAILED,
        '提交內容不可為空（content 或附件至少一項）',
      );
    }

    const submission = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.SubmissionUncheckedUpdateInput = { submittedAt: new Date() };
      if (dto.content !== undefined) data.content = dto.content;

      const row = await tx.submission.upsert({
        where: { assignmentId_studentId: { assignmentId, studentId: student.id } },
        create: {
          assignmentId,
          studentId: student.id,
          content: dto.content,
          submittedAt: new Date(),
        },
        update: data,
        include: submissionInclude,
      });

      if (dto.newAttachmentIds) {
        // 驗證附件屬於本人且掛在這個作業（上傳時以 assignmentId 暫掛）
        const attachments = await tx.attachment.findMany({
          where: { id: { in: dto.newAttachmentIds } },
        });
        for (const id of dto.newAttachmentIds) {
          const found = attachments.find((a) => a.id === id);
          if (!found || found.uploadedByUserId !== user.userId || found.assignmentId !== assignmentId) {
            throw AppException.badRequest(ErrorCode.ATTACHMENT_REJECTED, '附件無效或不屬於此作業', {
              attachmentId: id,
            });
          }
        }
        // 取代舊附件：舊的解除綁定，新的綁到 submission
        await tx.attachment.updateMany({
          where: { submissionId: row.id },
          data: { submissionId: null },
        });
        await tx.attachment.updateMany({
          where: { id: { in: dto.newAttachmentIds } },
          data: { submissionId: row.id, assignmentId: null },
        });
      }
      return tx.submission.findUniqueOrThrow({
        where: { id: row.id },
        include: submissionInclude,
      });
    });

    return this.toDetail(submission);
  }

  /** 教師視角全班提交狀況：未提交者合成 PENDING。 */
  async listForAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
    query: ListSubmissionsQueryDto,
  ): Promise<PageResult<Record<string, unknown>>> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment || assignment.archivedAt) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', { assignmentId });
    }
    if (user.role === 'STUDENT') {
      throw AppException.forbidden('僅教師與助教可查看全班提交狀況', {});
    }
    if (user.role === 'TEACHER' && assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('無權存取此作業', { assignmentId });
    }

    // 全班 ACTIVE 學生 × 提交紀錄，合成每生一列
    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { classId: assignment.classId, status: 'ACTIVE' },
      include: { student: { include: { user: true } } },
      orderBy: { enrolledAt: 'asc' },
    });
    const submissions = await this.prisma.submission.findMany({
      where: { assignmentId },
      include: { analysisResults: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const byStudent = new Map(submissions.map((s) => [s.studentId, s]));

    const rows = enrollments.map((enrollment) => {
      const student = enrollment.student;
      const submission = byStudent.get(student.id);
      const status = submission ? submission.status : 'PENDING';
      return {
        submissionId: submission?.id ?? null,
        studentId: student.id,
        studentNumber: student.studentNumber,
        name: student.user.name,
        status,
        submittedAt: submission?.submittedAt?.toISOString() ?? null,
        grade: submission?.grade === null ? null : Number(submission?.grade),
        hasAnalysis: (submission?.analysisResults?.length ?? 0) > 0,
      };
    });

    const filtered = query.status ? rows.filter((r) => r.status === query.status) : rows;
    const total = filtered.length;
    const { skip, take } = toSkipTake(query.page, query.limit);
    const paged = filtered.slice(skip, skip + take);

    return buildPageResult(paged, query.page, query.limit, total);
  }

  async get(user: AuthenticatedUser, submissionId: string): Promise<Record<string, unknown>> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { ...submissionInclude, assignment: { include: { class: true } }, student: true },
    });
    if (!submission) {
      throw AppException.notFound(ErrorCode.SUBMISSION_NOT_FOUND, '找不到該提交', { submissionId });
    }
    if (user.role === 'STUDENT' && submission.student.userId !== user.userId) {
      throw AppException.forbidden('僅能查看自己的提交', { submissionId });
    }
    if (user.role === 'TEACHER' && submission.assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('無權存取此提交', { submissionId });
    }
    return this.toDetail(submission);
  }

  /** 教師／助教評分與發還。RETURNED 後鎖定。 */
  async grade(
    user: AuthenticatedUser,
    submissionId: string,
    dto: GradeSubmissionDto,
  ): Promise<Record<string, unknown>> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { ...submissionInclude, assignment: { include: { class: true } }, student: true },
    });
    if (!submission) {
      throw AppException.notFound(ErrorCode.SUBMISSION_NOT_FOUND, '找不到該提交', { submissionId });
    }
    if (user.role === 'STUDENT') {
      throw AppException.forbidden('僅教師與助教可評分', { submissionId });
    }
    if (user.role === 'TEACHER' && submission.assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('無權評分此提交', { submissionId });
    }
    if (submission.status === 'RETURNED') {
      throw AppException.conflict(
        ErrorCode.SUBMISSION_ALREADY_RETURNED,
        '已發還的提交不可再修改',
        {},
      );
    }
    if (dto.grade === undefined && !dto.feedback && !dto.returnToStudent) {
      throw AppException.badRequest(ErrorCode.COMMON_VALIDATION_FAILED, '沒有任何可更新的欄位');
    }

    const updated = await this.prisma.submission.update({
      where: { id: submissionId },
      data: {
        grade: dto.grade ?? undefined,
        feedback: dto.feedback ?? undefined,
        gradedAt: new Date(),
        status: dto.returnToStudent ? 'RETURNED' : 'GRADED',
      },
      include: submissionInclude,
    });

    // 發還 → 通知學生
    if (dto.returnToStudent) {
      await this.notifications.createForUsers(
        [submission.student.userId],
        'SUBMISSION_RETURNED',
        `批改已發還：${submission.assignment.title}`,
        dto.grade !== undefined ? `成績 ${dto.grade} 分，查看老師的回饋。` : '查看老師的回饋。',
        { submissionId, assignmentId: submission.assignmentId },
      );
    }
    return this.toDetail(updated);
  }

  // ── 內部 ────────────────────────────────────────────────────────────────

  private notAcceptable(message: string, details: Record<string, unknown>) {
    return AppException.conflict(ErrorCode.SUBMISSION_NOT_ACCEPTABLE, message, details);
  }

  private async resolveEnrolledStudent(user: AuthenticatedUser, assignmentId: string) {
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    if (!student) {
      throw AppException.forbidden('僅學生可提交作業', { assignmentId });
    }
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { classId: true },
    });
    const enrolled = await this.prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId: assignment?.classId ?? 'none', studentId: student.id } },
    });
    if (enrolled?.status !== 'ACTIVE') {
      throw AppException.forbidden('未加入此班級', { assignmentId });
    }
    return student;
  }

  private toDetail(row: SubmissionWithRelations): Record<string, unknown> {
    const latest = row.analysisResults[0];
    return {
      id: row.id,
      assignmentId: row.assignmentId,
      studentId: row.studentId,
      content: row.content,
      status: row.status,
      submittedAt: row.submittedAt,
      gradedAt: row.gradedAt?.toISOString() ?? null,
      grade: row.grade === null ? null : Number(row.grade),
      feedback: row.feedback,
      attachments: row.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        uploadedAt: a.createdAt,
      })),
      latestAnalysis: latest
        ? {
            id: latest.id,
            submissionId: latest.submissionId,
            status: latest.status,
            language: latest.language,
            errorCode: latest.errorCode,
            errorMessage: latest.errorMessage,
            createdAt: latest.createdAt,
            completedAt: latest.completedAt?.toISOString() ?? null,
          }
        : null,
    };
  }
}
