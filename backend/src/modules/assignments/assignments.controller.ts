import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { ListAssignmentsQueryDto } from './dto/list-assignments-query.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { AssignmentsService } from './assignments.service';

@ApiTags('Assignments')
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get('classes/:classId/assignments')
  @ApiOperation({ summary: '列出班級作業（學生僅見 PUBLISHED）' })
  async listByClass(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Query() query: ListAssignmentsQueryDto,
  ) {
    return this.assignments.listByClass(user, classId, query);
  }

  @Post('classes/:classId/assignments')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '建立作業（預設 DRAFT）' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Body() dto: CreateAssignmentDto,
  ) {
    return this.assignments.create(user, classId, dto);
  }

  @Get('assignments/:assignmentId')
  @ApiOperation({ summary: '取得作業詳情' })
  async get(@CurrentUser() user: AuthenticatedUser, @Param('assignmentId') assignmentId: string) {
    return this.assignments.get(user, assignmentId);
  }

  @Patch('assignments/:assignmentId')
  @Roles('TEACHER')
  @ApiOperation({ summary: '更新作業（含發佈/關閉/重開）' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateAssignmentDto,
  ) {
    return this.assignments.update(user, assignmentId, dto);
  }

  @Delete('assignments/:assignmentId')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '封存作業（軟刪除）' })
  async archive(@CurrentUser() user: AuthenticatedUser, @Param('assignmentId') assignmentId: string): Promise<void> {
    await this.assignments.archive(user, assignmentId);
  }
}
