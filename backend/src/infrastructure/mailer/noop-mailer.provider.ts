import { Injectable, Logger } from '@nestjs/common';
import type { MailerPort } from './mailer.port';

@Injectable()
export class NoopMailer implements MailerPort {
  private readonly logger = new Logger(NoopMailer.name);

  async send(options: { to: string; subject: string; text: string }): Promise<void> {
    // v1：不實寄；記錄意圖（收件人摘要，不記內容全文）
    this.logger.log(`mail queued（noop）→ ${options.to}：${options.subject}`);
  }
}
