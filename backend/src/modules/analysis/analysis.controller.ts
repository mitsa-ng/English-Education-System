import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { TriggerAnalysisDto } from './dto/trigger-analysis.dto';
import { AnalysisService } from './analysis.service';

@ApiTags('Analysis')
@Controller()
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post('submissions/:submissionId/analyze')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '觸發作文自動分析（非同步）' })
  async trigger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('submissionId') submissionId: string,
    @Body() dto: TriggerAnalysisDto,
  ) {
    return this.analysis.trigger(user, submissionId, dto);
  }

  @Get('submissions/:submissionId/analysis')
  @ApiOperation({ summary: '取得分析結果（?all=true 列出歷史）' })
  async getLatest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('submissionId') submissionId: string,
    @Query('all') all?: string,
  ) {
    return this.analysis.getLatest(user, submissionId, all === 'true');
  }
}
