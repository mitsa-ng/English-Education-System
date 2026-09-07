import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { AnalyzerClientModule } from './infrastructure/analyzer-client/analyzer-client.module';
import { MailerModule } from './infrastructure/mailer/mailer.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { ClassesModule } from './modules/classes/classes.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { FilesModule } from './modules/files/files.module';
import { GradesModule } from './modules/grades/grades.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StudentsModule } from './modules/students/students.module';
import { SubmissionsModule } from './modules/submissions/submissions.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('NODE_ENV') === 'test' ? 'silent' : 'info',
          genReqId: () => crypto.randomUUID(),
          // 安全紅線：Authorization / cookie 永不落 log；請求/回應 body 整體不記
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body',
              'res.body',
            ],
            censor: '[REDACTED]',
          },
          customProps: (req) => ({ requestId: (req as { id?: string }).id }),
          autoLogging: {
            ignore: (req) => typeof req.url === 'string' && req.url.startsWith('/v1/health'),
          },
        },
      }),
    }),
    PrismaModule,
    StorageModule,
    AnalyzerClientModule,
    MailerModule,
    AuthModule,
    UsersModule,
    ClassesModule,
    StudentsModule,
    AssignmentsModule,
    SubmissionsModule,
    FilesModule,
    AnalysisModule,
    GradesModule,
    AnnouncementsModule,
    NotificationsModule,
    AnalyticsModule,
    DiscoveryModule,
  ],
  providers: [
    // 註冊順序即執行順序：先驗 JWT（含 @Public 放行），再驗 @Roles
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
