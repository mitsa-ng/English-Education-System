import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.module';

const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 每小時掃一次（通知冪等去重見 scan()）
const DUE_SOON_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 小時內到期
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 同作業 24 小時內不重發

/**
 * 截止提醒排程（in-process，不引入外部 scheduler）：
 * 掃描 48 小時內到期的 PUBLISHED 作業 → 通知該班 ACTIVE 學生。
 * 測試環境不自動啟動（直接呼叫 scan()）。
 */
@Injectable()
export class DueSoonScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DueSoonScheduler.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.scan();
    }, SCAN_INTERVAL_MS);
    this.timer.unref();
    void this.scan(); // 啟動即掃一次
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async scan(now = new Date()): Promise<number> {
    const windowEnd = new Date(now.getTime() + DUE_SOON_WINDOW_MS);
    const assignments = await this.prisma.assignment.findMany({
      where: {
        status: 'PUBLISHED',
        archivedAt: null,
        dueAt: { gte: now, lte: windowEnd },
      },
      include: { class: true },
    });

    let notified = 0;
    for (const assignment of assignments) {
      // 去重：24 小時內已為此作業發過 DUE_SOON → 跳過
      const existing = await this.prisma.notification.findFirst({
        where: {
          type: 'ASSIGNMENT_DUE_SOON',
          payload: { path: ['assignmentId'], equals: assignment.id },
          createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (existing) {
        continue;
      }

      const enrollments = await this.prisma.classEnrollment.findMany({
        where: { classId: assignment.classId, status: 'ACTIVE' },
        include: { student: { select: { userId: true } } },
      });
      if (enrollments.length === 0) {
        continue;
      }
      await this.prisma.notification.createMany({
        data: enrollments.map((e) => ({
          userId: e.student.userId,
          type: 'ASSIGNMENT_DUE_SOON' as const,
          title: `作業即將截止：${assignment.title}`,
          body: `「${assignment.title}」將於 ${assignment.dueAt!.toISOString()} 截止。`,
          payload: { assignmentId: assignment.id, dueAt: assignment.dueAt!.toISOString() } as object,
        })),
      });
      notified += enrollments.length;
    }
    if (notified > 0) {
      this.logger.log(`due-soon 掃描：發出 ${notified} 則通知（${assignments.length} 個即將到期作業）`);
    }
    return notified;
  }
}
