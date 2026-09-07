import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class TriggerAnalysisDto {
  @ApiPropertyOptional({ default: 'en', example: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language: string = 'en';

  @ApiPropertyOptional({
    enum: ['content', 'latestFile'],
    default: 'content',
    description: '分析本文（content）或最新上傳檔案（latestFile，走 OCR）',
  })
  @IsOptional()
  @IsIn(['content', 'latestFile'])
  inputSource: 'content' | 'latestFile' = 'content';
}
