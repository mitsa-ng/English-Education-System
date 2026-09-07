import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'allowedRoles';

/** 宣告式角色限制：@Roles('TEACHER') → 僅該角色可進（RolesGuard 強制）。 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
