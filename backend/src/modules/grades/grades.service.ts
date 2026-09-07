import { Injectable } from '@nestjs/common';
import type { NotificationType } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  calculateGradebook,
  gradebookToCsv,
  type Gradebook,
} from './gradebook';
import type {
  CreateGradeCategoryDto,
  CreateGradeEntriesDto,
  UpdateGradeCategoryDto,
} from './dto/grade-category.dto';

@Injectable()
export class GradesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 類別 CRUD ────────────────────────────────────────────────────────────

  async listCategories(user: AuthenticatedUser, classId: string) {
    const klass = await this.assertClassAccess(user, classId);
    const categories = await this.prisma.gradeCategory.findMany({
      where: { classId: klass.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      data: categories.map((c) => ({ id: c.id, classId: c.classId, name: c.name, weight: Number(c.weight) })),
    };
  }

  async createCategory(user: AuthenticatedUser, classId: string, dto: CreateGradeCategoryDto) {
    const klass = await this.assertClassAccess(user, classId, { teacherOnly: true });
    await this.assertWeightBudget(classId, dto.weight);
    let created;
    try {
      created = await this.prisma.gradeCategory.create({
        data: { classId: klass.id, name: dto.name, weight: dto.weight },
      });
    } catch (error) {
      throw this.mapCategoryWriteError(error, dto.name);
    }
    return { id: created.id, classId: created.classId, name: created.name, weight: Number(created.weight) };
  }

  async updateCategory(user: AuthenticatedUser, categoryId: string, dto: UpdateGradeCategoryDto) {
    const category = await this.loadOwnedCategory(user, categoryId);
    const newWeight = dto.weight ?? Number(category.weight);
    const others = await this.prisma.gradeCategory.aggregate({
      where: { classId: category.classId, id: { not: category.id } },
      _sum: { weight: true },
    });
    const total = Number(others._sum.weight ?? 0) + newWeight;
    if (total > 100) {
      throw AppException.conflict(ErrorCode.GRADE_WEIGHT_EXCEEDED, '權重總和超過 100', {
        currentTotal: Number(others._sum.weight ?? 0),
        attempted: newWeight,
      });
    }
    let updated;
    try {
      updated = await this.prisma.gradeCategory.update({
        where: { id: categoryId },
        data: { name: dto.name ?? undefined, weight: dto.weight ?? undefined },
      });
    } catch (error) {
      throw this.mapCategoryWriteError(error, dto.name ?? '');
    }
    return { id: updated.id, classId: updated.classId, name: updated.name, weight: Number(updated.weight) };
  }

  /** Prisma P2002（同班同名）→ 409，不讓它變 500。 */
  private mapCategoryWriteError(error: unknown, name: string): AppException {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      return AppException.conflict(ErrorCode.GRADE_CATEGORY_NAME_TAKEN, '同班級已有同名類別', { name });
    }
    throw error;
  }

  async deleteCategory(user: AuthenticatedUser, categoryId: string): Promise<void> {
    const category = await this.loadOwnedCategory(user, categoryId);
    await this.prisma.gradeCategory.delete({ where: { id: category.id } });
  }

  /** 權重總和 ≤ 100（建立時：既有總和 + 新權重）。 */
  private async assertWeightBudget(classId: string, additionalWeight: number) {
    const aggregate = await this.prisma.gradeCategory.aggregate({
      where: { classId },
      _sum: { weight: true },
    });
    const total = Number(aggregate._sum.weight ?? 0) + additionalWeight;
    if (total > 100) {
      throw AppException.conflict(ErrorCode.GRADE_WEIGHT_EXCEEDED, '權重總和超過 100', {
        currentTotal: Number(aggregate._sum.weight ?? 0),
        attempted: additionalWeight,
      });
    }
  }

  private async loadOwnedCategory(user: AuthenticatedUser, categoryId: string) {
    const category = await this.prisma.gradeCategory.findUnique({
      where: { id: categoryId },
      include: { class: true },
    });
    if (!category) {
      throw AppException.notFound(ErrorCode.GRADE_CATEGORY_NOT_FOUND, '找不到該成績類別', { categoryId });
    }
    if (user.role !== 'TEACHER' || category.class.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可管理成績類別', { categoryId });
    }
    return category;
  }

  // ── 分項成績登打 ─────────────────────────────────────────────────────────

  async createEntries(user: AuthenticatedUser, categoryId: string, dto: CreateGradeEntriesDto) {
    const category = await this.prisma.gradeCategory.findUnique({
      where: { id: categoryId },
      include: { class: true },
    });
    if (!category) {
      throw AppException.notFound(ErrorCode.GRADE_CATEGORY_NOT_FOUND, '找不到該成績類別', { categoryId });
    }
    // 助教可登打成績（RBAC 矩陣：grades 助教＝讀取＋輸入）；學生不可
    if (user.role === 'STUDENT' || (user.role === 'TEACHER' && category.class.teacherId !== user.userId)) {
      throw AppException.forbidden('無權登打此類別成績', { categoryId });
    }

    // 學生必須是該班 ACTIVE 成員
    const enrolled = await this.prisma.classEnrollment.findMany({
      where: { classId: category.classId, status: 'ACTIVE' },
      select: { studentId: true },
    });
    const enrolledIds = new Set(enrolled.map((e) => e.studentId));
    for (const entry of dto.entries) {
      if (!enrolledIds.has(entry.studentId)) {
        throw AppException.badRequest(
          ErrorCode.GRADE_ENTRY_STUDENT_INVALID,
          '學生不在此班級中',
          { studentId: entry.studentId },
        );
      }
    }

    const created = [];
    for (const entry of dto.entries) {
      const row = await this.prisma.gradeEntry.create({
        data: {
          categoryId,
          studentId: entry.studentId,
          score: entry.score,
          note: entry.note,
          recordedByUserId: user.userId,
        },
      });
      created.push({
        id: row.id,
        categoryId: row.categoryId,
        studentId: row.studentId,
        score: Number(row.score),
        note: row.note,
        recordedAt: row.recordedAt,
      });
    }
    return { data: created };
  }

  // ── 總表 / 匯出 / 計算 ──────────────────────────────────────────────────

  async getGradebook(user: AuthenticatedUser, classId: string): Promise<Gradebook> {
    const klass = await this.assertClassAccess(user, classId);
    return this.computeGradebook(klass.id);
  }

  async calculateAndNotify(user: AuthenticatedUser, classId: string): Promise<Gradebook> {
    const klass = await this.assertClassAccess(user, classId);
    const gradebook = await this.computeGradebook(klass.id);

    // 成績發佈通知：全班 ACTIVE 學生
    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { classId: klass.id, status: 'ACTIVE' },
      include: { student: { select: { userId: true } } },
    });
    if (enrollments.length > 0) {
      await this.prisma.notification.createMany({
        data: enrollments.map((e) => ({
          userId: e.student.userId,
          type: 'GRADE_PUBLISHED' as NotificationType,
          title: '成績已更新',
          body: `「${klass.name}」的加權成績已計算完成，前往查看。`,
          payload: { classId: klass.id } as object,
        })),
      });
    }
    return gradebook;
  }

  async exportCsv(user: AuthenticatedUser, classId: string): Promise<{ csv: string; filename: string }> {
    const klass = await this.assertClassAccess(user, classId);
    const gradebook = await this.computeGradebook(klass.id);
    return { csv: gradebookToCsv(gradebook), filename: `grades-${klass.id}.csv` };
  }

  async getStudentGrades(user: AuthenticatedUser, studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true },
    });
    if (!student) {
      throw AppException.notFound(ErrorCode.STUDENT_NOT_FOUND, '找不到該學生', { studentId });
    }
    if (user.role === 'STUDENT' && student.userId !== user.userId) {
      throw AppException.forbidden('僅能查看自己的成績', { studentId });
    }
    if (user.role === 'TEACHER' && student.teacherId !== user.userId) {
      throw AppException.forbidden('無權查看此學生成績', { studentId });
    }

    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { studentId, status: 'ACTIVE' },
      select: { classId: true },
    });
    const classIds = enrollments.map((e) => e.classId);
    const data = [];
    for (const classId of classIds) {
      const gradebook = await this.computeGradebook(classId, studentId);
      const klass = await this.prisma.class.findUniqueOrThrow({ where: { id: classId } });
      const row = gradebook.rows[0];
      if (row) {
        data.push({ classId, className: klass.name, categories: row.categories, weightedTotal: row.weightedTotal });
      }
    }
    return { data };
  }

  private async computeGradebook(classId: string, onlyStudentId?: string): Promise<Gradebook> {
    const [categories, entries, enrollments] = await Promise.all([
      this.prisma.gradeCategory.findMany({ where: { classId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.gradeEntry.findMany({
        where: onlyStudentId
          ? { categoryId: { in: (await this.categoryIds(classId)) }, studentId: onlyStudentId }
          : { category: { classId } },
      }),
      this.prisma.classEnrollment.findMany({
        where: { classId, status: 'ACTIVE' },
        include: { student: { include: { user: { select: { name: true } } } } },
        orderBy: { enrolledAt: 'asc' },
      }),
    ]);

    return calculateGradebook(
      classId,
      categories.map((c) => ({ id: c.id, name: c.name, weight: Number(c.weight) })),
      entries.map((e) => ({ categoryId: e.categoryId, studentId: e.studentId, score: Number(e.score) })),
      enrollments.map((e) => ({
        studentId: e.studentId,
        name: e.student.user.name,
        studentNumber: e.student.studentNumber,
      })),
    );
  }

  private async categoryIds(classId: string): Promise<string[]> {
    const categories = await this.prisma.gradeCategory.findMany({
      where: { classId },
      select: { id: true },
    });
    return categories.map((c) => c.id);
  }

  private async assertClassAccess(
    user: AuthenticatedUser,
    classId: string,
    options: { teacherOnly?: boolean } = {},
  ) {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (user.role === 'ASSISTANT' && !options.teacherOnly) {
      return klass;
    }
    if (user.role === 'STUDENT') {
      throw AppException.forbidden('學生請使用 /v1/students/{id}/grades 查看自己的成績', { classId });
    }
    if (klass.teacherId !== user.userId) {
      throw AppException.forbidden('無權存取此班級成績', { classId });
    }
    return klass;
  }
}
