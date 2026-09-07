import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitAssignmentDto {
  @ApiPropertyOptional({ description: '作業本文（作文必填）' })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  content?: string;

  @ApiPropertyOptional({
    type: String,
    description: '先經 /v1/uploads（帶 assignmentId）取得的附件 ID，提供時取代舊附件',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  newAttachmentIds?: string[];
}
