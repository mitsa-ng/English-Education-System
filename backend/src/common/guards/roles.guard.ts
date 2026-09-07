import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ErrorCode } from '../errors/error-codes';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * 角色守衛：讀 @Roles(...) 宣告，角色不符回 403。
 * 沒有 @Roles 宣告的路由不設限（ JWT guard 已擋未認證）。
 * 與 JwtAuthGuard 串接：APP_GUARD 依註冊順序執行，本 guard 需註冊在其後。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed || allowed.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user || !allowed.includes(user.role)) {
      throw new ForbiddenException({
        code: ErrorCode.AUTH_ROLE_NOT_ALLOWED,
        message: '此操作不允許目前角色',
        details: { allowedRoles: allowed },
      });
    }
    return true;
  }
}
