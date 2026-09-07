import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedUser {
  userId: string;
  role: 'TEACHER' | 'STUDENT' | 'ASSISTANT';
}

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser }
    >();
    if (!request.user) {
      throw new Error('CurrentUser used outside an authenticated route');
    }
    return request.user;
  },
);
