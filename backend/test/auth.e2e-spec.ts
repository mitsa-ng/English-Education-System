import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/infrastructure/database/prisma.module';

/**
 * Auth 全流程 e2e：註冊 → 登入 → refresh（rotation + 重用撤銷）→ logout。
 * 需要測試資料庫：npm run test:e2e 會自動起 postgres-test 容器（localhost:5433）。
 */

describe('Auth e2e (supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const teacherEmail = `teacher_${runId}@test.dev`;
  const password = 'a-long-enough-password';

  beforeAll(async () => {
    // env（DATABASE_URL/JWT_SECRET）由 test/setup-e2e.ts 統一預設；
    // CI 會提供自己的值，這裡不再覆蓋。
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /v1/discovery & /v1/health（公開端點）', () => {
    it('discovery 回傳站點資訊', async () => {
      const res = await request(app.getHttpServer()).get('/v1/discovery').expect(200);
      expect(res.body).toMatchObject({ apiVersion: 'v1' });
      expect(res.body.serverName).toEqual(expect.any(String));
    });

    it('health 回傳 ok', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('教師註冊', () => {
    it('註冊成功：回 accessToken、refresh token 走 httpOnly cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: teacherEmail, password, name: '測試教師' })
        .expect(201);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user).toMatchObject({ role: 'TEACHER', name: '測試教師' });
      expect(res.body.refreshToken).toBeUndefined(); // 明文不進 body

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toMatch(/HttpOnly/i);
      expect(refreshCookie).toMatch(/Path=\/v1\/auth/);
    });

    it('重複註冊 → 409 + 統一錯誤格式', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: teacherEmail, password, name: '測試教師' })
        .expect(409);

      expect(res.body.error).toMatchObject({
        code: 'AUTH_EMAIL_ALREADY_USED',
        message: expect.any(String),
      });
      expect(res.body.error.details).toEqual(expect.any(Object));
    });

    it('密碼太短 → 400 COMMON_VALIDATION_FAILED，details 帶欄位資訊', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: `short_${runId}@test.dev`, password: '1234', name: '短密碼' })
        .expect(400);

      expect(res.body.error.code).toBe('COMMON_VALIDATION_FAILED');
      expect(res.body.error.details.fields).toEqual(expect.any(Array));
    });
  });

  describe('登入與 /users/me', () => {
    it('錯誤密碼 → 401 AUTH_INVALID_CREDENTIALS', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: teacherEmail, password: 'wrong-password' })
        .expect(401);

      expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('登入成功後可存取 /users/me（Bearer）', async () => {
      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: teacherEmail, password })
        .expect(200);

      const me = await request(app.getHttpServer())
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);

      expect(me.body).toMatchObject({ role: 'TEACHER', email: teacherEmail });
    });

    it('無 token 存取 /users/me → 401 統一錯誤格式', async () => {
      const res = await request(app.getHttpServer()).get('/v1/users/me').expect(401);
      expect(res.body.error).toMatchObject({
        code: expect.stringMatching(/^AUTH_/),
        message: expect.any(String),
      });
    });
  });

  describe('refresh token rotation 與重用偵測', () => {
    it('首次 refresh 成功且換發新 cookie；舊 token 重用 → 401（family 撤銷）', async () => {
      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: teacherEmail, password })
        .expect(200);
      const firstCookie = extractCookie(login.headers['set-cookie'], 'refreshToken');

      // 首次 refresh：成功
      const refreshed = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', `refreshToken=${firstCookie}`)
        .expect(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
      const secondCookie = extractCookie(refreshed.headers['set-cookie'], 'refreshToken');
      expect(secondCookie).not.toBe(firstCookie);

      // 舊 token 重用：401，且新 token（同 family）也一併被撤銷
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', `refreshToken=${firstCookie}`)
        .expect(401);

      const reuseNew = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', `refreshToken=${secondCookie}`)
        .expect(401);
      expect(reuseNew.body.error.code).toBe('AUTH_REFRESH_TOKEN_INVALID');
    });
  });

  describe('logout', () => {
    it('logout 後 refresh token 失效', async () => {
      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: teacherEmail, password })
        .expect(200);
      const cookie = extractCookie(login.headers['set-cookie'], 'refreshToken');
      const accessToken = login.body.accessToken as string;

      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', `refreshToken=${cookie}`)
        .expect(204);

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', `refreshToken=${cookie}`)
        .expect(401);
    });
  });

  describe('學生邀請碼註冊', () => {
    let teacherId: string;

    beforeAll(async () => {
      const teacher = await prisma.user.findUniqueOrThrow({ where: { email: teacherEmail } });
      teacherId = teacher.id;
    });

    it('有效邀請碼 → 201 且自動建檔加入班級', async () => {
      const klass = await prisma.class.create({
        data: {
          teacherId,
          name: `e2e 班級 ${runId}`,
          inviteCode: `E2E${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/v1/auth/register/student')
        .send({
          inviteCode: klass.inviteCode,
          username: `student_${runId}`,
          password,
          name: '測試學生',
        })
        .expect(201);

      expect(res.body.user).toMatchObject({ role: 'STUDENT', name: '測試學生' });

      const student = await prisma.student.findUniqueOrThrow({
        where: { userId: res.body.user.id },
        include: { enrollments: true },
      });
      expect(student.teacherId).toBe(teacherId);
      expect(student.enrollments).toHaveLength(1);
      expect(student.enrollments[0].classId).toBe(klass.id);
    });

    it('無效邀請碼 → 410 AUTH_INVITE_CODE_INVALID', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/register/student')
        .send({
          inviteCode: 'ZZZZ-ZZZZ',
          username: `student_bad_${runId}`,
          password,
          name: '路人',
        })
        .expect(410);

      expect(res.body.error.code).toBe('AUTH_INVITE_CODE_INVALID');
    });
  });
});

function extractCookie(setCookie: unknown, name: string): string {
  const cookies = Array.isArray(setCookie) ? (setCookie as string[]) : [];
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`cookie ${name} not found in ${JSON.stringify(setCookie)}`);
  }
  return found.split(';')[0].slice(name.length + 1);
}
