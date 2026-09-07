import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../token.service';
import { PrismaService } from '../../../infrastructure/database/prisma.module';

/**
 * Bearer JWT 驗證：payload 僅含 sub(userId) 與 role；
 * 使用者是否存在於 DB 由這裡把關（token 有效但帳號已刪 → 401）。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      // env.validation 已在啟動時擋掉缺漏，此處為防禦性把關
      throw new Error('JWT_SECRET is required');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: ErrorCode.AUTH_TOKEN_INVALID,
        message: '帳號不存在或已停用',
      });
    }
    return { userId: user.id, role: user.role };
  }
}
