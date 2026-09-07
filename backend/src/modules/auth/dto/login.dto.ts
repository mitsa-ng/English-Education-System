import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** email 與 username 二選一（AuthService 入口檢查）。 */
export class LoginDto {
  @ApiProperty({ required: false, example: 'teacher@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: 'student_01' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  username?: string;

  @ApiProperty({ example: '密碼' })
  @IsString()
  @MaxLength(128)
  password!: string;
}
