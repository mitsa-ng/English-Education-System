import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infrastructure/database/prisma.module';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { LoginDto } from './dto/login.dto';
import { RegisterStudentDto } from './dto/register-student.dto';
import { RegisterTeacherDto } from './dto/register-teacher.dto';
import { BCRYPT_ROUNDS, TokenService } from './token.service';

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; role: 'TEACHER' | 'STUDENT' | 'ASSISTANT'; name: string; email?: string | null; username?: string | null };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async registerTeacher(dto: RegisterTeacherDto): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw AppException.conflict(
        ErrorCode.AUTH_EMAIL_ALREADY_USED,
        '此 email 已註冊',
        { email: dto.email },
      );
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, role: 'TEACHER', name: dto.name },
    });
    return this.buildAuthResult(user.id, 'TEACHER', user.name, user.email, user.username);
  }

  async registerStudent(dto: RegisterStudentDto): Promise<AuthResult> {
    // condition check upfront：username/email 至少一個
    if (!dto.username && !dto.email) {
      throw AppException.badRequest(
        ErrorCode.COMMON_VALIDATION_FAILED,
        'username 與 email 至少填寫一個',
      );
    }

    const klass = await this.prisma.class.findFirst({
      where: {
        inviteCode: dto.inviteCode,
        status: 'ACTIVE',
        archivedAt: null,
        OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: new Date() } }],
      },
      select: { id: true, teacherId: true },
    });
    if (!klass) {
      throw AppException.gone(
        ErrorCode.AUTH_INVITE_CODE_INVALID,
        '邀請碼無效或已過期',
        { inviteCode: dto.inviteCode },
      );
    }

    if (dto.username) {
      const taken = await this.prisma.user.findUnique({ where: { username: dto.username } });
      if (taken) {
        throw AppException.conflict(ErrorCode.AUTH_USERNAME_TAKEN, '此使用者名稱已被使用', {
          username: dto.username,
        });
      }
    }
    if (dto.email) {
      const taken = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (taken) {
        throw AppException.conflict(ErrorCode.AUTH_EMAIL_ALREADY_USED, '此 email 已註冊', {
          email: dto.email,
        });
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // 帳號 + 學生檔案 + 班級加入，一個交易單位
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          username: dto.username,
          passwordHash,
          role: 'STUDENT',
          name: dto.name,
        },
      });
      const student = await tx.student.create({
        data: { teacherId: klass.teacherId, userId: created.id },
      });
      const already = await tx.classEnrollment.findUnique({
        where: { classId_studentId: { classId: klass.id, studentId: student.id } },
      });
      if (already) {
        throw AppException.conflict(ErrorCode.CLASS_ALREADY_ENROLLED, '學生已在該班級中');
      }
      await tx.classEnrollment.create({
        data: { classId: klass.id, studentId: student.id },
      });
      return created;
    });

    return this.buildAuthResult(user.id, 'STUDENT', user.name, user.email, user.username);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    if (!dto.email && !dto.username) {
      throw AppException.badRequest(
        ErrorCode.COMMON_VALIDATION_FAILED,
        'email 與 username 至少填寫一個',
      );
    }
    const user = await this.prisma.user.findFirst({
      where: dto.email ? { email: dto.email } : { username: dto.username },
    });
    // 防時序攻擊：使用者不存在也跑一次 hash 比對
    const passwordHash =
      user?.passwordHash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpUvHzGE9zSnzWn0mUeEW7dGkFlIm';
    const valid = await bcrypt.compare(dto.password, passwordHash);
    if (!user || !valid) {
      throw AppException.unauthorized(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        '帳號或密碼錯誤',
      );
    }
    return this.buildAuthResult(
      user.id,
      user.role,
      user.name,
      user.email,
      user.username,
    );
  }

  private async buildAuthResult(
    userId: string,
    role: 'TEACHER' | 'STUDENT' | 'ASSISTANT',
    name: string,
    email: string | null,
    username: string | null,
  ): Promise<AuthResult> {
    const { accessToken, expiresIn } = this.tokens.issueAccessToken(userId, role);
    const refreshToken = await this.tokens.issueRefreshToken(userId);
    return {
      accessToken,
      expiresIn,
      refreshToken,
      user: { id: userId, role, name, email, username },
    };
  }
}
