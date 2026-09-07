import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../infrastructure/database/prisma.module';

export interface AccessTokenPayload {
  sub: string;
  role: 'TEACHER' | 'STUDENT' | 'ASSISTANT';
}

export interface IssuedTokens {
  accessToken: string;
  /** 有效期（秒），供前端掌握刷新時機 */
  expiresIn: number;
}

const REFRESH_COOKIE_NAME = 'refreshToken';
const BCRYPT_ROUNDS = 12;

/**
 * Token 生命週期管理（separate decision from actions：
 * 產發/輪替/撤銷的「動作」集中於此，可獨立單元測試）。
 *
 * Refresh token 策略：
 * - 明文只出現一次（cookie 下發），DB 存 sha256 hash
 * - rotation：每次 refresh 產新 token、作廢舊的，同屬一個 familyId
 * - 重用偵測：已 revoked 的 token 再度出現 → 撤銷整個 family
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  issueAccessToken(userId: string, role: AccessTokenPayload['role']): IssuedTokens {
    const payload: AccessTokenPayload = { sub: userId, role };
    const ttlMinutes = this.config.get<number>('JWT_ACCESS_TTL_MINUTES') ?? 15;
    const accessToken = this.jwt.sign(payload, { expiresIn: `${ttlMinutes}m` });
    return { accessToken, expiresIn: ttlMinutes * 60 };
  }

  async issueRefreshToken(userId: string, familyId?: string): Promise<string> {
    const token = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30;
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        familyId: familyId ?? randomBytes(16).toString('hex'),
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      },
    });
    return token;
  }

  /**
   * 驗證並輪替 refresh token。
   * @returns 新的 access + refresh token 與使用者資訊
   */
  async rotateRefreshToken(
    presentedToken: string | undefined,
  ): Promise<{ tokens: IssuedTokens; refresh: string; user: { id: string; role: AccessTokenPayload['role'] } }> {
    const invalid = AppException.unauthorized(
      ErrorCode.AUTH_REFRESH_TOKEN_INVALID,
      'refresh token 無效，請重新登入',
    );

    if (!presentedToken) {
      throw invalid;
    }

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(presentedToken) },
      include: { user: { select: { id: true, role: true, passwordHash: true } } },
    });

    if (!record) {
      throw invalid;
    }

    // 重用偵測：已撤銷的 token 再出現 → 撤銷整條 family
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw invalid;
    }

    if (record.expiresAt < new Date()) {
      throw invalid;
    }

    // 輪替：作廢舊 token，同 family 發新的
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });
    const nextRefresh = await this.issueRefreshToken(record.userId, record.familyId);
    const tokens = this.issueAccessToken(
      record.user.id,
      record.user.role as AccessTokenPayload['role'],
    );
    return {
      tokens,
      refresh: nextRefresh,
      user: { id: record.user.id, role: record.user.role as AccessTokenPayload['role'] },
    };
  }

  async revokeRefreshToken(presentedToken: string | undefined): Promise<void> {
    if (!presentedToken) {
      return; // 冪等：沒有 cookie 也算登出成功
    }
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(presentedToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  buildRefreshCookie(): {
    name: string;
    options: {
      httpOnly: true;
      secure: boolean;
      sameSite: 'lax';
      path: string;
      maxAge: number;
    };
  } {
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30;
    return {
      name: REFRESH_COOKIE_NAME,
      options: {
        httpOnly: true,
        secure: this.config.get<boolean>('COOKIE_SECURE') ?? false,
        sameSite: 'lax',
        path: '/v1/auth',
        maxAge: ttlDays * 24 * 60 * 60 * 1000,
      },
    };
  }

  buildClearCookie(): { name: string; options: { path: string } } {
    return { name: REFRESH_COOKIE_NAME, options: { path: '/v1/auth' } };
  }
}

export { REFRESH_COOKIE_NAME, BCRYPT_ROUNDS };
