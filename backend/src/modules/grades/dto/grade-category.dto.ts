import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateGradeCategoryDto {
  @ApiProperty({ example: '平時成績' })
  @IsString()
  @MaxLength(40)
  name!: string;

  @ApiProperty({ minimum: 0, maximum: 100, example: 30 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  weight!: number;
}

export class UpdateGradeCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  weight?: number;
}

class GradeEntryInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  studentId!: string;

  @ApiProperty({ minimum: 0, maximum: 100, example: 87.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  score!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class CreateGradeEntriesDto {
  @ApiProperty({ type: [GradeEntryInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GradeEntryInputDto)
  entries!: GradeEntryInputDto[];
}
