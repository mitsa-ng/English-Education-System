import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

class AddStudentEntryDto {
  @ApiProperty({ example: '陳大同' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: '07' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  studentNumber?: string;

  @ApiPropertyOptional({ description: '省略則由系統生成' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  username?: string;

  @ApiPropertyOptional({ description: '省略則由系統生成隨機密碼' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  initialPassword?: string;
}

export class AddStudentsDto {
  @ApiProperty({ type: [AddStudentEntryDto], maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AddStudentEntryDto)
  students!: AddStudentEntryDto[];
}
