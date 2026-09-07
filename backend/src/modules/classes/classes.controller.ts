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
import { CreateClassDto } from './dto/create-class.dto';
import { JoinClassDto } from './dto/join-class.dto';
import { ListClassesQueryDto } from './dto/list-classes-query.dto';
import { UpdateClassDto } from './dto/update-class.dto';
import { ClassesService } from './classes.service';

@ApiTags('Classes')
@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  @ApiOperation({ summary: '列出班級（教師/助教：全部；學生：已加入者）' })
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListClassesQueryDto) {
    return this.classes.list(user, query);
  }

  @Post()
  @Roles('TEACHER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '建立班級（同時產生邀請碼）' })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateClassDto) {
    return this.classes.create(user, dto);
  }

  @Post('join')
  @Roles('STUDENT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '學生以邀請碼加入班級' })
  async join(@CurrentUser() user: AuthenticatedUser, @Body() dto: JoinClassDto) {
    return this.classes.join(user, dto.inviteCode);
  }

  @Get(':classId')
  @ApiOperation({ summary: '取得班級詳情' })
  async get(@CurrentUser() user: AuthenticatedUser, @Param('classId') classId: string) {
    return this.classes.get(user, classId);
  }

  @Patch(':classId')
  @Roles('TEACHER')
  @ApiOperation({ summary: '更新班級資訊' })
  async update(@CurrentUser() user: AuthenticatedUser, @Param('classId') classId: string, @Body() dto: UpdateClassDto) {
    return this.classes.update(user, classId, dto);
  }

  @Delete(':classId')
  @Roles('TEACHER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '封存班級（軟刪除）' })
  async archive(@CurrentUser() user: AuthenticatedUser, @Param('classId') classId: string): Promise<void> {
    await this.classes.archive(user, classId);
  }
}
