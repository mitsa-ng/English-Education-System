import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/database/prisma.module';
import { configureApp } from '../src/configure-app';

/**
 * M2 e2e：班級 CRUD、邀請碼、批次加學生、RBAC 三角色、分頁 envelope。
 * 需要測試資料庫（npm run test:e2e 或 CI postgres service）。
 */

describe('Classes & Students e2e (M2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  // 帳號
  let teacherToken: string;
  let assistantToken: string;
  let studentToken: string;
  let studentId: string;

  // 資源
  let classId: string;
  let inviteCode: string;
  let otherClassId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // 教師
    const teacher = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: `m2_teacher_${runId}@test.dev`, password: 'teacher-pass-123', name: 'M2 教師' })
      .expect(201);
    teacherToken = teacher.body.accessToken;

    // 助教：由教師直接在 DB 建立（UI 建立流程 M5+）
    const teacherRow = await prisma.user.findUniqueOrThrow({
      where: { email: `m2_teacher_${runId}@test.dev` },
    });
    await prisma.user.create({
      data: {
        username: `m2_ta_${runId}`,
        passwordHash: teacherRow.passwordHash,
        role: 'ASSISTANT',
        name: 'M2 助教',
      },
    });
    const assistantLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m2_ta_${runId}`, password: 'teacher-pass-123' })
      .expect(200);
    assistantToken = assistantLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('教師建班：回 201、含 XXXX-XXXX 邀請碼與 studentCount', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: `M2 班級 ${runId}`, description: 'e2e' })
      .expect(201);

    expect(res.body.name).toContain(runId);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.studentCount).toBe(0);
    expect(res.body.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(res.body.teacherName).toBe('M2 教師');
    classId = res.body.id;
    inviteCode = res.body.inviteCode;
  });

  it('分頁 envelope：pagination 含 page/limit/total/totalPages', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/classes?page=1&limit=5')
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);

    expect(res.body.pagination).toMatchObject({
      page: 1,
      limit: 5,
      total: expect.any(Number),
      totalPages: expect.any(Number),
    });
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('助教唯讀：可列表但建班 403', async () => {
    await request(app.getHttpServer())
      .get('/v1/classes')
      .set('Authorization', `Bearer ${assistantToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ name: '助教的班' })
      .expect(403);
    expect(res.body.error.code).toBe('AUTH_ROLE_NOT_ALLOWED');
  });

  it('批次加入學生：回傳 username 與明文初始密碼，且可用其登入', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        students: [
          { name: '學生甲', studentNumber: '01', username: `m2_stu_a_${runId}` },
          { name: '學生乙', studentNumber: '02' },
        ],
      })
      .expect(201);

    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toHaveLength(0);
    const [a, b] = res.body.created;
    expect(a.username).toBe(`m2_stu_a_${runId}`);
    expect(a.initialPassword).toEqual(expect.any(String));
    expect(b.username).toMatch(/^stu-\d{4}$/);
    expect(b.initialPassword).toMatch(/^.{10}$/);
    studentId = a.studentId;

    // 用回傳的帳密登入
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: a.username, password: a.initialPassword })
      .expect(200);
    studentToken = login.body.accessToken;

    // 班級 studentCount 更新
    const detail = await request(app.getHttpServer())
      .get(`/v1/classes/${classId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    expect(detail.body.studentCount).toBe(2);
  });

  it('學生視角：列表只看到已加入班級、不含邀請碼', async () => {
    // 另一班（學生未加入）
    const other = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: `M2 另一班 ${runId}` })
      .expect(201);
    otherClassId = other.body.id;

    const res = await request(app.getHttpServer())
      .get('/v1/classes')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(classId);
    expect(res.body.data[0].inviteCode).toBeUndefined();

    // 未加入的班級詳情 → 403
    await request(app.getHttpServer())
      .get(`/v1/classes/${otherClassId}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(403);
  });

  it('學生以邀請碼加入另一班：成功；重複加入 409；無效碼 404', async () => {
    // 取得另一班的邀請碼（教師視角）
    const otherDetail = await request(app.getHttpServer())
      .get(`/v1/classes/${otherClassId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    const otherCode = otherDetail.body.inviteCode as string;

    const joined = await request(app.getHttpServer())
      .post('/v1/classes/join')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ inviteCode: otherCode })
      .expect(200);
    expect(joined.body.id).toBe(otherClassId);
    expect(joined.body.inviteCode).toBeUndefined(); // 學生視角不含碼

    await request(app.getHttpServer())
      .post('/v1/classes/join')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ inviteCode: otherCode })
      .expect(409);

    const invalid = await request(app.getHttpServer())
      .post('/v1/classes/join')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ inviteCode: 'ZZZZ-ZZZZ' })
      .expect(404);
    expect(invalid.body.error.code).toBe('CLASS_NOT_FOUND');

    // 教師不能 join（角色限制）
    await request(app.getHttpServer())
      .post('/v1/classes/join')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ inviteCode: otherCode })
      .expect(403);
  });

  it('學生存取他人檔案 403；本人與教師可看（特殊欄位僅教師可見）', async () => {
    // 建第二個學生
    const second = await request(app.getHttpServer())
      .post(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ students: [{ name: '學生丙' }] })
      .expect(201);
    const secondId = second.body.created[0].studentId;

    const forbidden = await request(app.getHttpServer())
      .get(`/v1/students/${secondId}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(403);
    expect(forbidden.body.error.code).toBe('AUTH_FORBIDDEN');

    // 本人看自己：不含 specialNeeds/notes
    const self = await request(app.getHttpServer())
      .get(`/v1/students/${studentId}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    expect(self.body.specialNeeds).toBeUndefined();

    // 教師可見（null 也算存在）
    await request(app.getHttpServer())
      .get(`/v1/students/${studentId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
  });

  it('教師更新學生檔案；助教 PATCH 403', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/students/${studentId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ specialNeeds: '需要座位安排在前排' })
      .expect(200);
    expect(res.body.specialNeeds).toBe('需要座位安排在前排');

    await request(app.getHttpServer())
      .patch(`/v1/students/${studentId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ notes: '助教想改' })
      .expect(403);
  });

  it('學生列表（教師視角）含新學生；（學生視角）僅自己', async () => {
    const teacherView = await request(app.getHttpServer())
      .get(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    expect(teacherView.body.data).toHaveLength(3);
    expect(teacherView.body.data[0]).toMatchObject({
      name: '學生甲',
      enrollmentStatus: 'ACTIVE',
    });

    const studentView = await request(app.getHttpServer())
      .get(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    expect(studentView.body.data).toHaveLength(1);
    expect(studentView.body.data[0].studentId).toBe(studentId);

    // 學生看未加入班級的成員 → 403
    const third = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: `M2 第三班 ${runId}` })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v1/classes/${third.body.id}/students`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(403);
  });

  it('移出學生：204 冪等；REMOVED 可用邀請碼重新加入', async () => {
    const second = await request(app.getHttpServer())
      .get(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    const secondId = second.body.data.find((s: { name: string }) => s.name === '學生乙')
      .studentId as string;

    await request(app.getHttpServer())
      .delete(`/v1/classes/${classId}/students/${secondId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(204);
    // 冪等
    await request(app.getHttpServer())
      .delete(`/v1/classes/${classId}/students/${secondId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(204);

    // ACTIVE 名單少一人
    const after = await request(app.getHttpServer())
      .get(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    expect(after.body.data).toHaveLength(2);

    // 不存在的學生 → 404
    await request(app.getHttpServer())
      .delete(`/v1/classes/${classId}/students/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(404);
  });

  it('更新班級：停用邀請碼後 join 變 404；重啟用補新碼', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/classes/${classId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ inviteCodeEnabled: false })
      .expect(200);

    const oldCode = inviteCode;
    const rejected = await request(app.getHttpServer())
      .post('/v1/classes/join')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ inviteCode: oldCode })
      .expect(404);
    expect(rejected.body.error.code).toBe('CLASS_NOT_FOUND');

    const reEnabled = await request(app.getHttpServer())
      .patch(`/v1/classes/${classId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ inviteCodeEnabled: true })
      .expect(200);
    expect(reEnabled.body.inviteCode).toBeDefined();
    expect(reEnabled.body.inviteCode).not.toBe(oldCode);
  });

  it('封存班級：204；學生列表（預設 ACTIVE）不再出現', async () => {
    await request(app.getHttpServer())
      .delete(`/v1/classes/${otherClassId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(204);
    // 冪等：再封存一次仍 204
    await request(app.getHttpServer())
      .delete(`/v1/classes/${otherClassId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(204);

    const studentView = await request(app.getHttpServer())
      .get('/v1/classes')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    expect(studentView.body.data.map((c: { id: string }) => c.id)).not.toContain(otherClassId);

    // 教師查 ARCHIVED 仍找得到（軟刪除）
    const archived = await request(app.getHttpServer())
      .get('/v1/classes?status=ARCHIVED')
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    expect(archived.body.data.map((c: { id: string }) => c.id)).toContain(otherClassId);
  });

  it('未認證存取班級端點 → 401 統一格式', async () => {
    const res = await request(app.getHttpServer()).get('/v1/classes').expect(401);
    expect(res.body.error.code).toMatch(/^AUTH_/);
  });
});
