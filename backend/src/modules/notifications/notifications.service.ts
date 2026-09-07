import { Injectable } from '@nestjs/common';
import type { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { buildPageResult, toSkipTake, type PageResult } from '../../common/types/pagination';

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  read: boolean;
  readAt: string | null;
  createdAt: Date;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createForUsers(
    userIds: string[],
    type: NotificationType,
    title: string,
    body: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, type, title, body, payload: payload as object })),
    });
  }

  async list(
    user: AuthenticatedUser,
    query: { page: number; limit: number; unreadOnly?: boolean },
  ): Promise<PageResult<NotificationDto>> {
    const where: Prisma.NotificationWhereInput = { userId: user.userId };
    if (query.unreadOnly) {
      where.readAt = null;
    }
    const { skip, take } = toSkipTake(query.page, query.limit);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return buildPageResult(
      rows.map((row) => this.toDto(row)),
      query.page,
      query.limit,
      total,
    );
  }

  async markRead(user: AuthenticatedUser, notificationId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!notification || notification.userId !== user.userId) {
      throw AppException.notFound(ErrorCode.NOTIFICATION_NOT_FOUND, '找不到該通知', { notificationId });
    }
    if (!notification.readAt) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { readAt: new Date() },
      });
    }
  }

  private toDto(row: {
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    payload: Prisma.JsonValue | null;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      read: row.readAt !== null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt,
    };
  }
}
