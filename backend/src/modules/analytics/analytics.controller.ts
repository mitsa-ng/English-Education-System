import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';

class PrePostQuery {
  @IsUUID()
  preAssignmentId!: string;

  @IsUUID()
  postAssignmentId!: string;
}

@ApiTags('Analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('students/:studentId/progress')
  @ApiOperation({ summary: '學習歷程與進步趨勢' })
  async getProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('studentId') studentId: string,
    @Query('since') since?: string,
  ) {
    return this.analytics.getStudentProgress(user, studentId, since);
  }

  @Get('classes/:classId/analytics/pre-post')
  @ApiOperation({ summary: '前後測配對統計（paired t-test、Cohen\'s d）' })
  async getPrePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Query() query: PrePostQuery,
  ) {
    return this.analytics.getPrePostAnalysis(user, classId, query.preAssignmentId, query.postAssignmentId);
  }
}
