import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 學生自助註冊：以班級邀請碼加入。
 * username 與 email 二選一（AuthService 入口檢查至少一個）。
 */
export class RegisterStudentDto {
  @ApiProperty({ example: 'AB3D-7K9M' })
  @IsString()
  @MinLength(6)
  @MaxLength(12)
  inviteCode!: string;

  @ApiProperty({ required: false, example: 'student_01' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  username?: string;

  @ApiProperty({ required: false, example: 'student@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: '至少8個字元的密碼', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: '陳大同' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;
}
