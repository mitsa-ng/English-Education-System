import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { ListSubmissionsQueryDto } from './dto/list-submissions-query.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';
import { SubmissionsService } from './submissions.service';

@ApiTags('Submissions')
@Controller()
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Get('assignments/:assignmentId/submissions')
  @Roles('TEACHER', 'ASSISTANT')
  @ApiOperation({ summary: '全班提交狀況（未提交者合成 PENDING）' })
  async listForAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId') assignmentId: string,
    @Query() query: ListSubmissionsQueryDto,
  ) {
    return this.submissions.listForAssignment(user, assignmentId, query);
  }

  @Post('assignments/:assignmentId/submissions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '學生提交／重新提交（upsert）' })
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: SubmitAssignmentDto,
  ) {
    return this.submissions.submit(user, assignmentId, dto);
  }

  @Get('submissions/:submissionId')
  @ApiOperation({ summary: '取得提交詳情' })
  async get(@CurrentUser() user: AuthenticatedUser, @Param('submissionId') submissionId: string) {
    return this.submissions.get(user, submissionId);
  }

  @Patch('submissions/:submissionId/grade')
  @Roles('TEACHER', 'ASSISTANT')
  @ApiOperation({ summary: '教師評分與回饋（可同時發還）' })
  async grade(
    @CurrentUser() user: AuthenticatedUser,
    @Param('submissionId') submissionId: string,
    @Body() dto: GradeSubmissionDto,
  ) {
    return this.submissions.grade(user, submissionId, dto);
  }
}
