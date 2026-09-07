import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAssignmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, description: 'null 清除截止時間' })
  @IsOptional()
  @IsDateString()
  dueAt?: string | null;

  @ApiPropertyOptional({ enum: ['DRAFT', 'PUBLISHED', 'CLOSED'], description: '狀態轉換' })
  @IsOptional()
  @IsEnum(['DRAFT', 'PUBLISHED', 'CLOSED'])
  status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
}
