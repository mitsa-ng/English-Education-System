import { Injectable } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { buildPageResult, toSkipTake, type PageResult } from '../../common/types/pagination';
import { generateInviteCode } from './invite-code';
import type { CreateClassDto } from './dto/create-class.dto';
import type { UpdateClassDto } from './dto/update-class.dto';
import type { ListClassesQueryDto } from './dto/list-classes-query.dto';

const classInclude = {
  teacher: { select: { name: true } },
  _count: {
    select: {
      enrollments: { where: { status: 'ACTIVE' as const } },
      assignments: { where: { archivedAt: null } },
    },
  },
} satisfies Prisma.ClassInclude;

type ClassWithCounts = Prisma.ClassGetPayload<{ include: typeof classInclude }>;

export interface ClassSummaryDto {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  studentCount: number;
  inviteCode?: string;
  inviteExpiresAt?: string | null;
  createdAt: Date;
}

export interface ClassDetailDto extends ClassSummaryDto {
  assignmentCount: number;
  teacherName: string;
}

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 查詢 ────────────────────────────────────────────────────────────────

  async list(user: AuthenticatedUser, query: ListClassesQueryDto): Promise<PageResult<ClassSummaryDto>> {
    const status = query.status ?? 'ACTIVE';
    const where: Prisma.ClassWhereInput = { status };

    if (user.role === 'TEACHER') {
      where.teacherId = user.userId;
    } else if (user.role === 'STUDENT') {
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      where.enrollments = { some: { studentId: student?.id ?? 'none', status: 'ACTIVE' } };
    }
    // ASSISTANT：實例層唯讀，看全部

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.class.findMany({
        where,
        include: classInclude,
        orderBy: { [query.sortBy]: query.order },
        skip,
        take,
      }),
      this.prisma.class.count({ where }),
    ]);

    return buildPageResult(
      rows.map((row) => this.toSummary(row, user.role)),
      query.page,
      query.limit,
      total,
    );
  }

  async get(user: AuthenticatedUser, classId: string): Promise<ClassDetailDto> {
    const klass = await this.prisma.class.findUnique({ where: { id: classId }, include: classInclude });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    await this.assertClassVisible(user, klass.id);
    return this.toDetail(klass, user.role);
  }

  // ── 教師操作 ─────────────────────────────────────────────────────────────

  async create(user: AuthenticatedUser, dto: CreateClassDto): Promise<ClassDetailDto> {
    const data: Prisma.ClassUncheckedCreateInput = {
      teacherId: user.userId,
      name: dto.name,
      description: dto.description,
    };
    if (dto.generateInviteCode !== false) {
      data.inviteCode = await this.uniqueInviteCode();
    }
    const created = await this.prisma.class.create({ data, include: classInclude });
    return this.toDetail(created, user.role);
  }

  async update(user: AuthenticatedUser, classId: string, dto: UpdateClassDto): Promise<ClassDetailDto> {
    const klass = await this.assertTeacherOwnsClass(user, classId);

    const data: Prisma.ClassUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.inviteExpiresAt !== undefined) {
      data.inviteExpiresAt = dto.inviteExpiresAt === null ? null : new Date(dto.inviteExpiresAt);
    }
    if (dto.inviteCodeEnabled === false) {
      data.inviteCode = null;
      data.inviteExpiresAt = null;
    } else if (dto.inviteCodeEnabled === true && !klass.inviteCode) {
      data.inviteCode = await this.uniqueInviteCode();
    }

    const updated = await this.prisma.class.update({
      where: { id: classId },
      data,
      include: classInclude,
    });
    return this.toDetail(updated, user.role);
  }

  async archive(user: AuthenticatedUser, classId: string): Promise<void> {
    await this.assertTeacherOwnsClass(user, classId);
    await this.prisma.class.update({
      where: { id: classId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  // ── 學生加入 ────────────────────────────────────────────────────────────

  async join(user: AuthenticatedUser, inviteCode: string): Promise<ClassSummaryDto> {
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    if (!student) {
      throw AppException.notFound(ErrorCode.STUDENT_NOT_FOUND, '找不到學生檔案', {});
    }

    const klass = await this.prisma.class.findFirst({
      where: {
        inviteCode,
        status: 'ACTIVE',
        archivedAt: null,
        OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: new Date() } }],
      },
      include: classInclude,
    });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '邀請碼無效或班級不存在', { inviteCode });
    }

    const existing = await this.prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId: klass.id, studentId: student.id } },
    });
    if (existing?.status === 'ACTIVE') {
      throw AppException.conflict(ErrorCode.CLASS_ALREADY_ENROLLED, '學生已在該班級中', {});
    }

    if (existing) {
      await this.prisma.classEnrollment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', removedAt: null },
      });
    } else {
      await this.prisma.classEnrollment.create({
        data: { classId: klass.id, studentId: student.id },
      });
    }
    return this.toSummary(klass, user.role);
  }

  // ── 內部共用 ────────────────────────────────────────────────────────────

  /** 教師身分且為該班擁有者（單教師實例下即部署者）；不存在回 404、非擁有者回 403。 */
  async assertTeacherOwnsClass(user: AuthenticatedUser, classId: string) {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (klass.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可執行此操作', { classId });
    }
    return klass;
  }

  private async assertClassVisible(user: AuthenticatedUser, classId: string): Promise<void> {
    if (user.role === 'TEACHER' || user.role === 'ASSISTANT') {
      // 教師僅看自己的班（單教師實例差異不大，但語意正確）
      if (user.role === 'TEACHER') {
        const klass = await this.prisma.class.findUnique({ where: { id: classId } });
        if (klass && klass.teacherId !== user.userId) {
          throw AppException.forbidden('無權存取此班級', { classId });
        }
      }
      return;
    }
    const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
    const enrolled = await this.prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId: student?.id ?? 'none' } },
    });
    if (enrolled?.status !== 'ACTIVE') {
      throw AppException.forbidden('未加入此班級', { classId });
    }
  }

  private async uniqueInviteCode(retries = 5): Promise<string> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const code = generateInviteCode();
      const clash = await this.prisma.class.findUnique({ where: { inviteCode: code }, select: { id: true } });
      if (!clash) {
        return code;
      }
    }
    throw AppException.conflict(ErrorCode.COMMON_INTERNAL_ERROR, '邀請碼生成失敗，請重試', {});
  }

  private toSummary(klass: ClassWithCounts, viewerRole: UserRole): ClassSummaryDto {
    const summary: ClassSummaryDto = {
      id: klass.id,
      name: klass.name,
      description: klass.description,
      status: klass.status,
      studentCount: klass._count.enrollments,
      createdAt: klass.createdAt,
    };
    if (viewerRole === 'TEACHER') {
      summary.inviteCode = klass.inviteCode ?? undefined;
      summary.inviteExpiresAt = klass.inviteExpiresAt?.toISOString() ?? null;
    }
    return summary;
  }

  private toDetail(klass: ClassWithCounts, viewerRole: UserRole): ClassDetailDto {
    return {
      ...this.toSummary(klass, viewerRole),
      assignmentCount: klass._count.assignments,
      teacherName: klass.teacher.name,
    };
  }
}
