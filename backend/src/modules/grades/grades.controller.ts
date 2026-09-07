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
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateGradeCategoryDto,
  CreateGradeEntriesDto,
  UpdateGradeCategoryDto,
} from './dto/grade-category.dto';
import { GradesService } from './grades.service';

@ApiTags('Grades')
@Controller()
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  // ── 類別 ────────────────────────────────────────────────────────────────

  @Get('classes/:classId/grade-categories')
  @ApiOperation({ summary: '列出成績類別與權重' })
  async listCategories(@CurrentUser() user: AuthenticatedUser, @Param('classId') classId: string) {
    return this.grades.listCategories(user, classId);
  }

  @Post('classes/:classId/grade-categories')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '建立成績類別（權重總和 ≤ 100）' })
  async createCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Body() dto: CreateGradeCategoryDto,
  ) {
    return this.grades.createCategory(user, classId, dto);
  }

  @Patch('grade-categories/:categoryId')
  @Roles('TEACHER')
  @ApiOperation({ summary: '更新類別名稱或權重' })
  async updateCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateGradeCategoryDto,
  ) {
    return this.grades.updateCategory(user, categoryId, dto);
  }

  @Delete('grade-categories/:categoryId')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '刪除類別（含其下分項成績）' })
  async deleteCategory(@CurrentUser() user: AuthenticatedUser, @Param('categoryId') categoryId: string): Promise<void> {
    await this.grades.deleteCategory(user, categoryId);
  }

  // ── 分項成績 ────────────────────────────────────────────────────────────

  @Post('grade-categories/:categoryId/entries')
  @Roles('TEACHER', 'ASSISTANT')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '批次登打分項成績' })
  async createEntries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('categoryId') categoryId: string,
    @Body() dto: CreateGradeEntriesDto,
  ) {
    return this.grades.createEntries(user, categoryId, dto);
  }

  // ── 總表 ────────────────────────────────────────────────────────────────

  @Get('classes/:classId/grades')
  @ApiOperation({ summary: '班級成績總表（即時加權計算）' })
  async getGradebook(@CurrentUser() user: AuthenticatedUser, @Param('classId') classId: string) {
    return this.grades.getGradebook(user, classId);
  }

  @Post('classes/:classId/grades/calculate')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '重新計算成績並通知全班（冪等重算）' })
  async calculate(@CurrentUser() user: AuthenticatedUser, @Param('classId') classId: string) {
    return this.grades.calculateAndNotify(user, classId);
  }

  @Get('classes/:classId/grades/export')
  @ApiOperation({ summary: '匯出成績 CSV（UTF-8 BOM）' })
  async exportCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Param('classId') classId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, filename } = await this.grades.exportCsv(user, classId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @Get('students/:studentId/grades')
  @ApiOperation({ summary: '單一學生成績（各班級分列）' })
  async getStudentGrades(@CurrentUser() user: AuthenticatedUser, @Param('studentId') studentId: string) {
    return this.grades.getStudentGrades(user, studentId);
  }
}
