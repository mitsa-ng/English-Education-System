import { Global, Module } from '@nestjs/common';
import { MAILER } from './mailer.port';
import { NoopMailer } from './noop-mailer.provider';

@Global()
@Module({
  providers: [{ provide: MAILER, useClass: NoopMailer }],
  exports: [MAILER],
})
export class MailerModule {}
