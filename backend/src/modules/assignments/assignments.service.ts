import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { buildPageResult, toSkipTake, type PageResult } from '../../common/types/pagination';
import type { CreateAssignmentDto } from './dto/create-assignment.dto';
import type { ListAssignmentsQueryDto } from './dto/list-assignments-query.dto';
import type { UpdateAssignmentDto } from './dto/update-assignment.dto';

type AssignmentStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';

/** 狀態機（data-model.md §3.1）：DRAFT→PUBLISHED→CLOSED，CLOSED 可重開為 PUBLISHED。 */
const ALLOWED_TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: ['PUBLISHED'],
};

const assignmentInclude = {
  attachments: true,
  _count: { select: { submissions: true } },
} satisfies Prisma.AssignmentInclude;

type AssignmentWithRelations = Prisma.AssignmentGetPayload<{ include: typeof assignmentInclude }>;

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listByClass(
    user: AuthenticatedUser,
    classId: string,
    query: ListAssignmentsQueryDto,
  ): Promise<PageResult<Record<string, unknown>>> {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }

    const where: Prisma.AssignmentWhereInput = {
      classId,
      archivedAt: null,
    };
    if (user.role === 'STUDENT') {
      // 學生僅見 PUBLISHED，且必須已加入該班
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      const enrolled = await this.prisma.classEnrollment.findUnique({
        where: { classId_studentId: { classId, studentId: student?.id ?? 'none' } },
      });
      if (enrolled?.status !== 'ACTIVE') {
        throw AppException.forbidden('未加入此班級', { classId });
      }
      where.status = query.status === 'PUBLISHED' || !query.status ? 'PUBLISHED' : query.status;
    } else {
      if (user.role === 'TEACHER' && klass.teacherId !== user.userId) {
        throw AppException.forbidden('無權存取此班級', { classId });
      }
      if (query.status) where.status = query.status;
    }
    if (query.type) where.type = query.type;

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.assignment.findMany({
        where,
        include: assignmentInclude,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.assignment.count({ where }),
    ]);

    return buildPageResult(
      rows.map((row) => this.toDto(row, user.role)),
      query.page,
      query.limit,
      total,
    );
  }

  async create(
    user: AuthenticatedUser,
    classId: string,
    dto: CreateAssignmentDto,
  ): Promise<Record<string, unknown>> {
    const klass = await this.assertTeacherOwnsActiveClass(user, classId);

    const created = await this.prisma.assignment.create({
      data: {
        classId: klass.id,
        title: dto.title,
        description: dto.description,
        type: dto.type,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        status: dto.publishNow ? 'PUBLISHED' : 'DRAFT',
        publishedAt: dto.publishNow ? new Date() : null,
      },
      include: assignmentInclude,
    });
    return this.toDto(created, user.role);
  }

  async get(user: AuthenticatedUser, assignmentId: string): Promise<Record<string, unknown>> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { ...assignmentInclude, class: true },
    });
    if (!assignment || assignment.archivedAt) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', { assignmentId });
    }
    await this.assertCanView(user, assignment);
    return this.toDto(assignment, user.role);
  }

  async update(
    user: AuthenticatedUser,
    assignmentId: string,
    dto: UpdateAssignmentDto,
  ): Promise<Record<string, unknown>> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { ...assignmentInclude, class: true },
    });
    if (!assignment || assignment.archivedAt) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', { assignmentId });
    }
    if (assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可修改作業', { assignmentId });
    }

    const data: Prisma.AssignmentUncheckedUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.dueAt !== undefined) {
      data.dueAt = dto.dueAt === null ? null : new Date(dto.dueAt);
    }
    if (dto.status !== undefined && dto.status !== assignment.status) {
      this.assertTransition(assignment.status, dto.status);
      data.status = dto.status;
      if (dto.status === 'PUBLISHED' && !assignment.publishedAt) {
        data.publishedAt = new Date();
      }
    }

    const updated = await this.prisma.assignment.update({
      where: { id: assignmentId },
      data,
      include: assignmentInclude,
    });
    return this.toDto(updated, user.role);
  }

  async archive(user: AuthenticatedUser, assignmentId: string): Promise<void> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment || assignment.archivedAt) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', { assignmentId });
    }
    if (assignment.class.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可封存作業', { assignmentId });
    }
    await this.prisma.assignment.update({
      where: { id: assignmentId },
      data: { archivedAt: new Date() },
    });
  }

  private assertTransition(from: AssignmentStatus, to: AssignmentStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw AppException.conflict(
        ErrorCode.ASSIGNMENT_INVALID_TRANSITION,
        '不允許的狀態轉換',
        { from, to },
      );
    }
  }

  private async assertTeacherOwnsActiveClass(user: AuthenticatedUser, classId: string) {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (klass.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可建立作業', { classId });
    }
    if (klass.status !== 'ACTIVE') {
      throw AppException.conflict(ErrorCode.CLASS_NOT_FOUND, '班級已封存，無法建立作業', { classId });
    }
    return klass;
  }

  private async assertCanView(
    user: AuthenticatedUser,
    assignment: { classId: string; status: AssignmentStatus; class: { teacherId: string } },
  ): Promise<void> {
    if (user.role === 'ASSISTANT') return;
    if (user.role === 'TEACHER') {
      if (assignment.class.teacherId !== user.userId) {
        throw AppException.forbidden('無權存取此作業', {});
      }
      return;
    }
    if (assignment.status !== 'PUBLISHED') {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '找不到該作業', {});
    }
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    const enrolled = await this.prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId: assignment.classId, studentId: student?.id ?? 'none' } },
    });
    if (enrolled?.status !== 'ACTIVE') {
      throw AppException.forbidden('未加入此班級', { classId: assignment.classId });
    }
  }

  private toDto(row: AssignmentWithRelations, viewerRole: string): Record<string, unknown> {
    const dto: Record<string, unknown> = {
      id: row.id,
      classId: row.classId,
      title: row.title,
      description: row.description,
      type: row.type,
      status: row.status,
      dueAt: row.dueAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt,
      attachments: row.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        uploadedAt: a.createdAt,
      })),
    };
    if (viewerRole !== 'STUDENT') {
      dto.submissionCount = row._count.submissions;
    }
    return dto;
  }
}
