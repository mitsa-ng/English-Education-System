import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateAnnouncementDto, ListAnnouncementsQuery } from './dto/announcement.dto';
import { AnnouncementsService } from './announcements.service';

@ApiTags('Announcements')
@Controller()
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get('classes/:classId/announcements')
  @ApiOperation({ summary: '列出班級公告' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Query() query: ListAnnouncementsQuery,
  ) {
    return this.announcements.list(user, classId, query);
  }

  @Post('classes/:classId/announcements')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '發佈公告（通知全班）' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.announcements.create(user, classId, dto);
  }
}
