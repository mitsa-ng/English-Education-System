import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UploadRequestDto } from './dto/upload-request.dto';
import { FilesService } from './files.service';

@ApiTags('Files')
@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '申請上傳（presigned PUT URL，10 分鐘效期）' })
  async createUpload(@CurrentUser() user: AuthenticatedUser, @Body() dto: UploadRequestDto) {
    return this.files.createUpload(user, dto);
  }

  @Get('attachments/:attachmentId/download-url')
  @ApiOperation({ summary: '取得附件下載 URL（presigned GET，10 分鐘效期）' })
  async getDownloadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.files.getDownloadUrl(user, attachmentId);
  }
}
