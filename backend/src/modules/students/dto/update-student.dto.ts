import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateStudentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  studentNumber?: string;

  @ApiPropertyOptional({ description: '特殊需求註記（IEP 等），僅教師可改' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specialNeeds?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
