import { Injectable, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../errors/error-codes';

/**
 * 全域 JWT guard：非 @Public() 端點一律要求 Bearer token。
 * 401 統一格式由 AllExceptionsFilter 補上 code（這裡攜帶 code 資訊）。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  override handleRequest<TUser>(err: unknown, user: false | TUser, info: unknown): TUser {
    if (err || !user) {
      const code =
        info instanceof Error && /expired/i.test(info.message)
          ? ErrorCode.AUTH_TOKEN_INVALID
          : ErrorCode.AUTH_TOKEN_MISSING;
      throw new UnauthorizedException({ code, message: '未提供有效的存取憑證' });
    }
    return user;
  }
}
