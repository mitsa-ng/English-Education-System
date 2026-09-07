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
import { AddStudentsDto } from './dto/add-students.dto';
import { ListClassStudentsQueryDto } from './dto/list-class-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentsService } from './students.service';

@ApiTags('Students')
@Controller()
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get('classes/:classId/students')
  @ApiOperation({ summary: '列出班級學生' })
  async listClassStudents(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Query() query: ListClassStudentsQueryDto,
  ) {
    return this.students.listClassStudents(user, classId, query);
  }

  @Post('classes/:classId/students')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '批次加入學生（回傳預設密碼清單）' })
  async addStudents(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Body() dto: AddStudentsDto,
  ) {
    return this.students.addStudents(user, classId, dto);
  }

  @Delete('classes/:classId/students/:studentId')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '將學生移出班級（enrollment → REMOVED）' })
  async removeFromClass(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Param('studentId') studentId: string,
  ): Promise<void> {
    await this.students.removeFromClass(user, classId, studentId);
  }

  @Get('students/:studentId')
  @ApiOperation({ summary: '取得學生檔案' })
  async getStudent(@CurrentUser() user: AuthenticatedUser, @Param('studentId') studentId: string) {
    return this.students.getStudent(user, studentId);
  }

  @Patch('students/:studentId')
  @Roles('TEACHER')
  @ApiOperation({ summary: '更新學生資料（註記、特殊需求、座號）' })
  async updateStudent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('studentId') studentId: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.students.updateStudent(user, studentId, dto);
  }
}
