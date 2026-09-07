import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { DueSoonScheduler } from './due-soon.scheduler';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, DueSoonScheduler],
  exports: [NotificationsService],
})
export class NotificationsModule {}
