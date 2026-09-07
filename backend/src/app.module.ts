import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
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
    AuthModule,
    UsersModule,
    DiscoveryModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
