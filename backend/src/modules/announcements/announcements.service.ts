import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { MAILER } from '../../infrastructure/mailer/mailer.port';
import type { MailerPort } from '../../infrastructure/mailer/mailer.port';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { buildPageResult, toSkipTake, type PageResult } from '../../common/types/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import type { CreateAnnouncementDto, ListAnnouncementsQuery } from './dto/announcement.dto';

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  async list(
    user: AuthenticatedUser,
    classId: string,
    query: ListAnnouncementsQuery,
  ): Promise<PageResult<Record<string, unknown>>> {
    await this.assertClassVisible(user, classId);
    const where = { classId };
    const { skip, take } = toSkipTake(query.page, query.limit);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.announcement.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        include: { author: { select: { name: true } } },
        skip,
        take,
      }),
      this.prisma.announcement.count({ where }),
    ]);
    return buildPageResult(
      rows.map((row) => ({
        id: row.id,
        classId: row.classId,
        title: row.title,
        body: row.body,
        publishedAt: row.publishedAt,
        authorName: row.author.name,
      })),
      query.page,
      query.limit,
      total,
    );
  }

  async create(user: AuthenticatedUser, classId: string, dto: CreateAnnouncementDto) {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass || klass.status !== 'ACTIVE') {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (klass.teacherId !== user.userId) {
      throw AppException.forbidden('僅班級擁有者可發佈公告', { classId });
    }

    const created = await this.prisma.announcement.create({
      data: { classId, authorUserId: user.userId, title: dto.title, body: dto.body },
      include: { author: { select: { name: true } } },
    });

    // 全班 ACTIVE 學生 → 站內通知 +（noop）email
    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { classId, status: 'ACTIVE' },
      include: { student: { include: { user: { select: { id: true, email: true } } } } },
    });
    await this.notifications.createForUsers(
      enrollments.map((e) => e.student.user.id),
      'ANNOUNCEMENT_NEW',
      `新公告：${dto.title}`,
      dto.body.slice(0, 200),
      { announcementId: created.id, classId },
    );
    for (const enrollment of enrollments) {
      const email = enrollment.student.user.email;
      if (email) {
        await this.mailer.send({
          to: email,
          subject: `[${klass.name}] 新公告：${dto.title}`,
          text: dto.body.slice(0, 2000),
        });
      }
    }

    return {
      id: created.id,
      classId: created.classId,
      title: created.title,
      body: created.body,
      publishedAt: created.publishedAt,
      authorName: created.author.name,
    };
  }

  private async assertClassVisible(user: AuthenticatedUser, classId: string): Promise<void> {
    const klass = await this.prisma.class.findUnique({ where: { id: classId } });
    if (!klass) {
      throw AppException.notFound(ErrorCode.CLASS_NOT_FOUND, '找不到該班級', { classId });
    }
    if (user.role === 'ASSISTANT') {
      return;
    }
    if (user.role === 'TEACHER') {
      if (klass.teacherId !== user.userId) {
        throw AppException.forbidden('無權存取此班級', { classId });
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
}
