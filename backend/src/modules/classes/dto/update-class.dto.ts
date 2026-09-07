import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateClassDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'false 停用邀請碼（清空）；true 補生成（若無）' })
  @IsOptional()
  @IsBoolean()
  inviteCodeEnabled?: boolean;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, description: 'null 表示永久有效' })
  @IsOptional()
  @IsDateString()
  inviteExpiresAt?: string | null;
}
