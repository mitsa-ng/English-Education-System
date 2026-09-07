import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class GradeSubmissionDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  grade?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  feedback?: string;

  @ApiPropertyOptional({ default: false, description: 'true 則狀態轉 RETURNED' })
  @IsOptional()
  @IsBoolean()
  returnToStudent?: boolean;
}
