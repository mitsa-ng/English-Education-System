import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { descriptive, interpretCohensD, pairedTTest } from './stats';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 學習歷程與進步趨勢：錯誤類別時間序列 + 分數趨勢（data-model.md §6）。 */
  async getStudentProgress(user: AuthenticatedUser, studentId: string, since?: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true },
    });
    if (!student) {
      throw AppException.notFound(ErrorCode.STUDENT_NOT_FOUND, '找不到該學生', { studentId });
    }
    if (user.role === 'STUDENT' && student.userId !== user.userId) {
      throw AppException.forbidden('僅能查看自己的趨勢', { studentId });
    }
    if (user.role === 'TEACHER' && student.teacherId !== user.userId) {
      throw AppException.forbidden('無權查看此學生', { studentId });
    }

    const sinceDate = since ? new Date(since) : undefined;

    // 作文錯誤時間序列（僅 COMPLETED 的分析）
    const analyses = await this.prisma.analysisResult.findMany({
      where: {
        status: 'COMPLETED',
        submission: { studentId },
        ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: { submission: { include: { assignment: { select: { id: true, title: true } } } } },
    });

    const essayErrorTrends = analyses
      .map((row) => {
        const result = row.resultJson as { summary?: Record<string, number> } | null;
        const summary = result?.summary;
        return {
          analysisId: row.id,
          assignmentId: row.submission.assignment.id,
          assignmentTitle: row.submission.assignment.title,
          date: row.createdAt,
          spellingCount: Number(summary?.spellingCount ?? 0),
          grammarCount: Number(summary?.grammarCount ?? 0),
          semanticCount: Number(summary?.semanticCount ?? 0),
          wordCount: Number(summary?.wordCount ?? 0),
        };
      })
      .filter((t) => t.wordCount > 0);

    // 分數趨勢（已評分提交）
    const graded = await this.prisma.submission.findMany({
      where: {
        studentId,
        grade: { not: null },
        ...(sinceDate ? { gradedAt: { gte: sinceDate } } : {}),
      },
      orderBy: { gradedAt: 'asc' },
      include: { assignment: { select: { id: true, title: true } } },
    });
    const scoreTrends = graded.map((row) => ({
      assignmentId: row.assignment.id,
      assignmentTitle: row.assignment.title,
      grade: Number(row.grade),
      gradedAt: row.gradedAt!.toISOString(),
    }));

    // 每百字錯誤數變化（最近一次 − 首次；負數 = 進步）
    let errorRateChange: number | null = null;
    if (essayErrorTrends.length >= 2) {
      const first = essayErrorTrends[0];
      const last = essayErrorTrends[essayErrorTrends.length - 1];
      const rate = (t: typeof first) =>
        ((t.spellingCount + t.grammarCount + t.semanticCount) / t.wordCount) * 100;
      errorRateChange = Math.round((rate(last) - rate(first)) * 100) / 100;
    }

    return {
      studentId,
      essayErrorTrends,
      scoreTrends,
      summary: {
        totalAnalyses: essayErrorTrends.length,
        totalGraded: scoreTrends.length,
        errorRateChange,
      },
    };
  }

  /** 前後測配對統計（paired t-test、Cohen's d）。 */
  async getPrePostAnalysis(
    user: AuthenticatedUser,
    classId: string,
    preAssignmentId: string,
    postAssignmentId: string,
  ) {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (user.role === 'STUDENT') {
      throw AppException.forbidden('僅教師與助教可查看班級分析', { classId });
    }
    if (user.role === 'TEACHER' && klass.teacherId !== user.userId) {
      throw AppException.forbidden('無權存取此班級', { classId });
    }
    if (preAssignmentId === postAssignmentId) {
      throw AppException.badRequest(
        ErrorCode.ANALYTICS_INVALID_ASSIGNMENT_PAIR,
        '前後測作業不可為同一個',
        { preAssignmentId },
      );
    }
    const assignments = await this.prisma.assignment.findMany({
      where: { id: { in: [preAssignmentId, postAssignmentId] }, classId },
      select: { id: true },
    });
    const found = new Set(assignments.map((a) => a.id));
    if (!found.has(preAssignmentId) || !found.has(postAssignmentId)) {
      throw AppException.notFound(ErrorCode.ASSIGNMENT_NOT_FOUND, '作業不存在或不屬於此班級', {
        preAssignmentId,
        postAssignmentId,
      });
    }

    const submissions = await this.prisma.submission.findMany({
      where: { assignmentId: { in: [preAssignmentId, postAssignmentId] }, grade: { not: null } },
      select: { studentId: true, assignmentId: true, grade: true },
    });
    const pre = new Map<string, number>();
    const post = new Map<string, number>();
    for (const s of submissions) {
      const score = Number(s.grade);
      if (s.assignmentId === preAssignmentId) {
        pre.set(s.studentId, score);
      } else {
        post.set(s.studentId, score);
      }
    }

    const enrolled = await this.prisma.classEnrollment.findMany({
      where: { classId, status: 'ACTIVE' },
      select: { studentId: true },
    });
    const pairedStudents = enrolled.filter((e) => pre.has(e.studentId) && post.has(e.studentId));
    const excludedCount = enrolled.length - pairedStudents.length;

    if (pairedStudents.length < 2) {
      throw AppException.badRequest(
        ErrorCode.COMMON_VALIDATION_FAILED,
        `可配對樣本不足（${pairedStudents.length} 組，至少需 2 組）`,
        { pairedCount: pairedStudents.length },
      );
    }

    const preScores = pairedStudents.map((e) => pre.get(e.studentId)!);
    const postScores = pairedStudents.map((e) => post.get(e.studentId)!);
    const test = pairedTTest(preScores, postScores);
    const diff = postScores.map((v, i) => v - preScores[i]);

    return {
      preAssignmentId,
      postAssignmentId,
      pairedCount: pairedStudents.length,
      excludedCount,
      pre: descriptive(preScores),
      post: descriptive(postScores),
      diff: descriptive(diff),
      tStatistic: round6(test.tStatistic),
      degreesOfFreedom: test.degreesOfFreedom,
      pValue: test.pValue,
      cohenD: round6(test.cohenD),
      significant: test.significant,
      interpretation: `${interpretCohensD(test.cohenD, test.significant)}，平均進步 ${round2(
        descriptive(diff).mean,
      )} 分`,
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
