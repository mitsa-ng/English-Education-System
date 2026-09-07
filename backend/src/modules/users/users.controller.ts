import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../infrastructure/database/prisma.module';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  @ApiOperation({ summary: '目前登入者資訊' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: {
        id: true,
        role: true,
        name: true,
        email: true,
        username: true,
        studentProfile: { select: { id: true, studentNumber: true } },
      },
    });
    return profile;
  }
}
