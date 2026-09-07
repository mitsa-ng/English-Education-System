import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class UploadRequestDto {
  @ApiProperty({ example: 'my-essay.pdf' })
  @IsString()
  filename!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  mimeType!: string;

  @ApiProperty({ minimum: 1, maximum: 20971520, description: `bytes（≤ 20MB）` })
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  sizeBytes!: number;

  @ApiPropertyOptional({ description: '作業 ID：教師＝說明附件；學生＝提交附件（提交時改掛 submission）' })
  @IsOptional()
  @IsUUID()
  assignmentId?: string;

  @ApiPropertyOptional({ description: '既有提交的附件（重新提交場景）' })
  @IsOptional()
  @IsUUID()
  submissionId?: string;
}
