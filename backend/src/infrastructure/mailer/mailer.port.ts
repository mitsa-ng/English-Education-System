/**
 * Email 基礎設施邊界：業務層只依賴此 port；
 * v1 為 NoopMailer（log only），未來接 SMTP（nodemailer）只換實作。
 */
export interface MailerPort {
  send(options: { to: string; subject: string; text: string }): Promise<void>;
}

export const MAILER = Symbol('MAILER');
