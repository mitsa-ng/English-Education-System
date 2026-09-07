import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService, type AuthResult } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterStudentDto } from './dto/register-student.dto';
import { RegisterTeacherDto } from './dto/register-teacher.dto';
import { REFRESH_COOKIE_NAME, TokenService } from './token.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  /** 共用：access token 進 body、refresh token 進 httpOnly cookie。 */
  private sendAuthResult(
    res: Response,
    result: AuthResult,
  ): Omit<AuthResult, 'refreshToken'> {
    const cookie = this.tokens.buildRefreshCookie();
    res.cookie(cookie.name, result.refreshToken, cookie.options);
    return { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '教師註冊' })
  async registerTeacher(
    @Body() dto: RegisterTeacherDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.registerTeacher(dto);
    return this.sendAuthResult(res, result);
  }

  @Public()
  @Post('register/student')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '學生以班級邀請碼自助註冊' })
  async registerStudent(
    @Body() dto: RegisterStudentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.registerStudent(dto);
    return this.sendAuthResult(res, result);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登入（教師／學生／助教共用）' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto);
    return this.sendAuthResult(res, result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '以 refresh token 換發新 access token（rotation）' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const presented = this.readRefreshCookie(req);
    const { tokens, refresh } = await this.tokens.rotateRefreshToken(presented);
    const cookie = this.tokens.buildRefreshCookie();
    res.cookie(cookie.name, refresh, cookie.options);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '登出（撤銷目前 refresh token）' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const presented = this.readRefreshCookie(req);
    await this.tokens.revokeRefreshToken(presented);
    const clear = this.tokens.buildClearCookie();
    res.clearCookie(clear.name, clear.options);
  }

  private readRefreshCookie(req: Request): string | undefined {
    const value = req.cookies?.[REFRESH_COOKIE_NAME];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
