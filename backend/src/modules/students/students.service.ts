import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { buildPageResult, toSkipTake, type PageResult } from '../../common/types/pagination';
import { BCRYPT_ROUNDS } from '../auth/token.service';
import { generateInitialPassword, generateUsernameSuffix } from '../classes/invite-code';
import type { AddStudentsDto } from './dto/add-students.dto';
import type { ListClassStudentsQueryDto } from './dto/list-class-students-query.dto';
import type { UpdateStudentDto } from './dto/update-student.dto';

export interface StudentInClassDto {
  studentId: string;
  userId: string;
  name: string;
  studentNumber: string | null;
  username: string | null;
  email: string | null;
  enrollmentStatus: 'ACTIVE' | 'REMOVED';
  /** 詳情（跨班視角）無對應班級時為 null */
  enrolledAt: Date | null;
}

export interface StudentDetailDto extends StudentInClassDto {
  specialNeeds?: string | null;
  notes?: string | null;
}

export interface AddStudentsResultDto {
  created: { studentId: string; name: string; username: string; initialPassword: string }[];
  failed: { name: string; reason: string }[];
}

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 批次加入 ────────────────────────────────────────────────────────────

  async addStudents(
    user: AuthenticatedUser,
    classId: string,
    dto: AddStudentsDto,
  ): Promise<AddStudentsResultDto> {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (klass.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可加入學生', { classId });
    }
    if (klass.status !== 'ACTIVE') {
      throw AppException.conflict(ErrorCode.CLASS_NOT_FOUND, '班級已封存，無法加入學生', { classId });
    }

    const result: AddStudentsResultDto = { created: [], failed: [] };
    for (const entry of dto.students) {
      try {
        const created = await this.createOneStudent(klass.teacherId, classId, entry);
        result.created.push(created);
      } catch (error) {
        const reason = error instanceof AppException ? error.message : '建立失敗';
        result.failed.push({ name: entry.name, reason });
      }
    }
    return result;
  }

  private async createOneStudent(
    teacherId: string,
    classId: string,
    entry: { name: string; studentNumber?: string; username?: string; initialPassword?: string },
  ): Promise<{ studentId: string; name: string; username: string; initialPassword: string }> {
    const username = entry.username ?? (await this.uniqueUsername());
    const initialPassword = entry.initialPassword ?? generateInitialPassword();
    const passwordHash = await bcrypt.hash(initialPassword, BCRYPT_ROUNDS);

    const { student } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { username, passwordHash, role: 'STUDENT', name: entry.name },
      });
      const student = await tx.student.create({
        data: { teacherId, userId: user.id, studentNumber: entry.studentNumber },
      });
      const already = await tx.classEnrollment.findUnique({
        where: { classId_studentId: { classId, studentId: student.id } },
      });
      if (already) {
        // 同一學生不可能重複建檔（每次都是新 User）；防禦性復活既有 enrollment
        await tx.classEnrollment.update({
          where: { id: already.id },
          data: { status: 'ACTIVE', removedAt: null },
        });
      } else {
        await tx.classEnrollment.create({ data: { classId, studentId: student.id } });
      }
      return { student };
    });

    return { studentId: student.id, name: entry.name, username, initialPassword };
  }

  private async uniqueUsername(base = 'stu'): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${base}-${generateUsernameSuffix()}`;
      const clash = await this.prisma.user.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (!clash) {
        return candidate;
      }
    }
    throw AppException.conflict(ErrorCode.AUTH_USERNAME_TAKEN, '無法生成可用 username，請手動指定', {});
  }

  // ── 班級學生列表 ─────────────────────────────────────────────────────────

  async listClassStudents(
    user: AuthenticatedUser,
    classId: string,
    query: ListClassStudentsQueryDto,
  ): Promise<PageResult<StudentInClassDto>> {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }

    const enrollmentWhere = {
      classId,
      status: query.status ?? ('ACTIVE' as const),
    };

    let studentScope: string | undefined;
    if (user.role === 'STUDENT') {
      // 學生僅能看自己在該班的資料；未加入的班直接擋
      const student = await this.prisma.student.findUnique({ where: { userId: user.userId } });
      const enrolled = await this.prisma.classEnrollment.findUnique({
        where: { classId_studentId: { classId, studentId: student?.id ?? 'none' } },
      });
      if (enrolled?.status !== 'ACTIVE') {
        throw AppException.forbidden('未加入此班級', { classId });
      }
      studentScope = student!.id;
    } else if (user.role === 'TEACHER' && klass.teacherId !== user.userId) {
      throw AppException.forbidden('無權存取此班級', { classId });
    }

    const where = studentScope
      ? { ...enrollmentWhere, studentId: studentScope }
      : enrollmentWhere;

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.classEnrollment.findMany({
        where,
        include: { student: { include: { user: true } } },
        orderBy: { enrolledAt: 'asc' },
        skip,
        take,
      }),
      this.prisma.classEnrollment.count({ where }),
    ]);

    const data = rows.map((row) => this.toInClass(row));
    return buildPageResult(data, query.page, query.limit, total);
  }

  // ── 單一學生 ─────────────────────────────────────────────────────────────

  async getStudent(user: AuthenticatedUser, studentId: string): Promise<StudentDetailDto> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true, enrollments: true },
    });
    if (!student) {
      throw AppException.notFound(ErrorCode.STUDENT_NOT_FOUND, '找不到該學生', { studentId });
    }
    await this.assertCanViewStudent(user, student.id, student.userId, student.teacherId);

    const detail: StudentDetailDto = {
      ...this.toDetailBase(student),
    };
    if (user.role !== 'STUDENT') {
      detail.specialNeeds = student.specialNeeds;
      detail.notes = student.notes;
    }
    return detail;
  }

  async updateStudent(
    user: AuthenticatedUser,
    studentId: string,
    dto: UpdateStudentDto,
  ): Promise<StudentDetailDto> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true, enrollments: true },
    });
    if (!student) {
      throw AppException.notFound(ErrorCode.STUDENT_NOT_FOUND, '找不到該學生', { studentId });
    }
    if (user.role !== 'TEACHER') {
      // 助教唯讀；學生本人 M2 不開放改檔
      throw AppException.forbidden('僅教師可修改學生檔案', { studentId });
    }
    if (student.teacherId !== user.userId) {
      throw AppException.forbidden('僅學生所屬教師可修改', { studentId });
    }

    const data: { studentNumber?: string; specialNeeds?: string; notes?: string } = {};
    if (dto.studentNumber !== undefined) data.studentNumber = dto.studentNumber;
    if (dto.specialNeeds !== undefined) data.specialNeeds = dto.specialNeeds;
    if (dto.notes !== undefined) data.notes = dto.notes;

    const updated = await this.prisma.student.update({
      where: { id: studentId },
      data,
      include: { user: true, enrollments: true },
    });
    return {
      ...this.toDetailBase(updated),
      specialNeeds: updated.specialNeeds,
      notes: updated.notes,
    };
  }

  async removeFromClass(user: AuthenticatedUser, classId: string, studentId: string): Promise<void> {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (klass.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可移出學生', { classId });
    }

    const enrollment = await this.prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
    });
    if (!enrollment) {
      throw AppException.notFound(ErrorCode.STUDENT_NOT_FOUND, '該學生不在此班級', { classId, studentId });
    }
    if (enrollment.status === 'ACTIVE') {
      await this.prisma.classEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'REMOVED', removedAt: new Date() },
      });
    }
    // 已 REMOVED → 冪等 204
  }

  // ── 內部 ────────────────────────────────────────────────────────────────

  private async assertCanViewStudent(
    user: AuthenticatedUser,
    studentId: string,
    studentUserId: string,
    teacherId: string,
  ): Promise<void> {
    if (user.role === 'ASSISTANT') return;
    if (user.role === 'TEACHER') {
      if (teacherId !== user.userId) {
        throw AppException.forbidden('無權存取此學生', { studentId });
      }
      return;
    }
    if (user.userId !== studentUserId) {
      throw AppException.forbidden('僅能查看自己的檔案', { studentId });
    }
  }

  private toInClass(row: {
    status: 'ACTIVE' | 'REMOVED';
    enrolledAt: Date;
    student: { id: string; userId: string; studentNumber: string | null; user: { name: string; username: string | null; email: string | null } };
  }): StudentInClassDto {
    return {
      studentId: row.student.id,
      userId: row.student.userId,
      name: row.student.user.name,
      studentNumber: row.student.studentNumber,
      username: row.student.user.username,
      email: row.student.user.email,
      enrollmentStatus: row.status,
      enrolledAt: row.enrolledAt,
    };
  }

  private toDetailBase(student: {
    id: string;
    userId: string;
    studentNumber: string | null;
    enrollments: { status: 'ACTIVE' | 'REMOVED'; enrolledAt: Date }[];
    user: { name: string; username: string | null; email: string | null };
  }): StudentDetailDto {
    const active = student.enrollments.find((e) => e.status === 'ACTIVE');
    return {
      studentId: student.id,
      userId: student.userId,
      name: student.user.name,
      studentNumber: student.studentNumber,
      username: student.user.username,
      email: student.user.email,
      enrollmentStatus: active ? 'ACTIVE' : 'REMOVED',
      // 詳情橫跨多班：取最近一次有效加入時間（無則 null）
      enrolledAt: active ? active.enrolledAt : null,
    };
  }
}
