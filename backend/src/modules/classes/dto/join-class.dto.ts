import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { INVITE_CODE_PATTERN } from '../invite-code';

export class JoinClassDto {
  @ApiProperty({ example: 'AB3D-7K9M' })
  @IsString()
  @MinLength(6)
  @MaxLength(12)
  @Matches(INVITE_CODE_PATTERN, { message: '邀請碼格式應為 XXXX-XXXX' })
  inviteCode!: string;
}
