import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateAssignmentDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @ApiProperty({ enum: ['ESSAY', 'GENERAL'] })
  @IsEnum(['ESSAY', 'GENERAL'])
  type!: 'ESSAY' | 'GENERAL';

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @ApiPropertyOptional({ default: false, description: 'true 則建立後直接 PUBLISHED' })
  @IsOptional()
  @IsBoolean()
  publishNow?: boolean;
}
