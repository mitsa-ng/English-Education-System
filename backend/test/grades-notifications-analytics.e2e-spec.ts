import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/database/prisma.module';
import { DueSoonScheduler } from '../src/modules/notifications/due-soon.scheduler';
import { configureApp } from '../src/configure-app';

/**
 * M5 e2e：成績（類別/登打/加權總表/CSV）、公告與通知（含發還、due-soon 排程）、
 * 進步趨勢與前後測分析。
 */

describe('Grades / Announcements / Analytics e2e (M5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  let teacherToken: string;
  let assistantToken: string;
  let studentTokenA: string;
  let studentTokenB: string;
  let studentAId: string;
  let studentBId: string;
  let classId: string;
  let preAssignmentId: string;
  let postAssignmentId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const teacher = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: `m5_teacher_${runId}@test.dev`, password: 'teacher-pass-123', name: 'M5 教師' })
      .expect(201);
    teacherToken = teacher.body.accessToken;

    const teacherRow = await prisma.user.findUniqueOrThrow({
      where: { email: `m5_teacher_${runId}@test.dev` },
    });
    await prisma.user.create({
      data: {
        username: `m5_ta_${runId}`,
        passwordHash: teacherRow.passwordHash,
        role: 'ASSISTANT',
        name: 'M5 助教',
      },
    });
    const assistantLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m5_ta_${runId}`, password: 'teacher-pass-123' })
      .expect(200);
    assistantToken = assistantLogin.body.accessToken;

    const klass = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: `M5 班級 ${runId}` })
      .expect(201);
    classId = klass.body.id;

    const students = await request(app.getHttpServer())
      .post(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        students: [
          { name: '甲生', username: `m5_a_${runId}` },
          { name: '乙生', username: `m5_b_${runId}` },
        ],
      })
      .expect(201);
    studentAId = students.body.created[0].studentId;
    studentBId = students.body.created[1].studentId;
    const loginA = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m5_a_${runId}`, password: students.body.created[0].initialPassword })
      .expect(200);
    studentTokenA = loginA.body.accessToken;
    const loginB = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m5_b_${runId}`, password: students.body.created[1].initialPassword })
      .expect(200);
    studentTokenB = loginB.body.accessToken;

    // 前後測兩個作業（發佈中、已評分）
    const pre = await request(app.getHttpServer())
      .post(`/v1/classes/${classId}/assignments`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: '前測', type: 'GENERAL', publishNow: true })
      .expect(201);
    preAssignmentId = pre.body.id;
    const post = await request(app.getHttpServer())
      .post(`/v1/classes/${classId}/assignments`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: '後測', type: 'GENERAL', publishNow: true })
      .expect(201);
    postAssignmentId = post.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function submitAndGrade(assignmentId: string, token: string, content: string, grade: number) {
    const submission = await request(app.getHttpServer())
      .post(`/v1/assignments/${assignmentId}/submissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/v1/submissions/${submission.body.id}/grade`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ grade })
      .expect(200);
    return submission.body.id as string;
  }

  describe('成績類別與登打', () => {
    it('權重總和超過 100 → 409 GRADE_WEIGHT_EXCEEDED', async () => {
      await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/grade-categories`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ name: '平時', weight: 30 })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/grade-categories`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ name: '期中', weight: 30 })
        .expect(201);
      const exceeded = await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/grade-categories`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ name: '期末', weight: 45 })
        .expect(409);
      expect(exceeded.body.error.code).toBe('GRADE_WEIGHT_EXCEEDED');

      // 重名檢查（此時總和 60，+5 不超限 → 會撞 P2002 重名）
      const dup = await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/grade-categories`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ name: '平時', weight: 5 })
        .expect(409);
      expect(dup.body.error.code).toBe('GRADE_CATEGORY_NAME_TAKEN');

      await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/grade-categories`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ name: '期末', weight: 40 })
        .expect(201);
    });

    it('批次登打（教師與助教皆可）；不存在的學生 → 400', async () => {
      const categories = await request(app.getHttpServer())
        .get(`/v1/classes/${classId}/grade-categories`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);
      const daily = categories.body.data.find((c: { name: string }) => c.name === '平時');
      const midterm = categories.body.data.find((c: { name: string }) => c.name === '期中');

      await request(app.getHttpServer())
        .post(`/v1/grade-categories/${daily.id}/entries`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          entries: [
            { studentId: studentAId, score: 80 },
            { studentId: studentBId, score: 90 },
          ],
        })
        .expect(201);

      // 助教也可登打（RBAC：grades 助教＝讀取＋輸入）
      await request(app.getHttpServer())
        .post(`/v1/grade-categories/${midterm.id}/entries`)
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({
          entries: [
            { studentId: studentAId, score: 70 },
            { studentId: studentBId, score: 85 },
          ],
        })
        .expect(201);

      const invalid = await request(app.getHttpServer())
        .post(`/v1/grade-categories/${daily.id}/entries`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ entries: [{ studentId: '00000000-0000-0000-0000-000000000000', score: 50 }] })
        .expect(400);
      expect(invalid.body.error.code).toBe('GRADE_ENTRY_STUDENT_INVALID');
    });

    it('加權總表：類別平均 × 權重；學生版只看自己', async () => {
      const gradebook = await request(app.getHttpServer())
        .get(`/v1/classes/${classId}/grades`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);

      expect(gradebook.body.rows).toHaveLength(2);
      const rowA = gradebook.body.rows.find((r: { name: string }) => r.name === '甲生');
      expect(rowA.weightedTotal).toBe(45); // 80×30% + 70×30% + 0×40%
      const daily = rowA.categories.find((c: { name: string }) => c.name === '平時');
      expect(daily).toMatchObject({ entryCount: 1, average: 80, weightedScore: 24 });
      const final = rowA.categories.find((c: { name: string }) => c.name === '期末');
      expect(final.average).toBeNull();

      // 學生查自己的成績
      const mine = await request(app.getHttpServer())
        .get(`/v1/students/${studentAId}/grades`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0].weightedTotal).toBe(45);

      // 學生查他人的 → 403
      await request(app.getHttpServer())
        .get(`/v1/students/${studentBId}/grades`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(403);

      // 學生不可看全班總表
      await request(app.getHttpServer())
        .get(`/v1/classes/${classId}/grades`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(403);
    });

    it('CSV 匯出：UTF-8 BOM、含姓名與總分欄', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/classes/${classId}/grades/export`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text.startsWith('\uFEFF')).toBe(true);
      expect(res.text).toContain('甲生');
      expect(res.text).toContain('加權總分');
    });
  });

  describe('公告與通知', () => {
    it('發佈公告 → 全班學生收到通知；標記已讀；未讀篩選', async () => {
      await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/announcements`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ title: '期末考前重點', body: '請複習第 1–5 課。' })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get('/v1/notifications')
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(list.body.pagination.total).toBeGreaterThanOrEqual(1);
      const announcementNotification = list.body.data.find(
        (n: { type: string }) => n.type === 'ANNOUNCEMENT_NEW',
      );
      expect(announcementNotification).toBeDefined();
      expect(announcementNotification.read).toBe(false);

      // 標記已讀（冪等）
      await request(app.getHttpServer())
        .patch(`/v1/notifications/${announcementNotification.id}/read`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(204);
      await request(app.getHttpServer())
        .patch(`/v1/notifications/${announcementNotification.id}/read`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(204);

      const unread = await request(app.getHttpServer())
        .get('/v1/notifications?unreadOnly=true')
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(
        unread.body.data.some((n: { id: string }) => n.id === announcementNotification.id),
      ).toBe(false);

      // 他人通知不可標記
      const otherList = await request(app.getHttpServer())
        .get('/v1/notifications')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .expect(200);
      const otherNotification = otherList.body.data[0];
      await request(app.getHttpServer())
        .patch(`/v1/notifications/${otherNotification.id}/read`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(404);
    });

    it('成績計算 → GRADE_PUBLISHED 通知全班', async () => {
      await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/grades/calculate`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);

      const list = await request(app.getHttpServer())
        .get('/v1/notifications')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .expect(200);
      expect(list.body.data.some((n: { type: string }) => n.type === 'GRADE_PUBLISHED')).toBe(true);
    });

    it('發還提交 → SUBMISSION_RETURNED 通知', async () => {
      const submissionId = await submitAndGrade(preAssignmentId, studentTokenA, 'pre essay', 60);
      await request(app.getHttpServer())
        .patch(`/v1/submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ returnToStudent: true })
        .expect(200);

      const list = await request(app.getHttpServer())
        .get('/v1/notifications')
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(list.body.data.some((n: { type: string }) => n.type === 'SUBMISSION_RETURNED')).toBe(true);
    });

    it('due-soon 掃描：48 小時內到期 → 通知；24 小時內不重發', async () => {
      await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/assignments`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          title: '快截止的作業',
          type: 'GENERAL',
          publishNow: true,
          dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
        .expect(201);

      const scheduler = app.get(DueSoonScheduler);
      const first = await scheduler.scan();
      expect(first).toBeGreaterThanOrEqual(2); // 兩位學生

      const second = await scheduler.scan();
      expect(second).toBe(0); // 去重

      const list = await request(app.getHttpServer())
        .get('/v1/notifications')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .expect(200);
      const dueSoon = list.body.data.filter((n: { type: string }) => n.type === 'ASSIGNMENT_DUE_SOON');
      expect(dueSoon).toHaveLength(1);
    });
  });

  describe('進步趨勢與前後測分析', () => {
    it('progress：分數趨勢有資料、無分析時 errorRateChange=null', async () => {
      // 補齊前後測配對：乙生前測 + 兩人後測
      await submitAndGrade(preAssignmentId, studentTokenB, 'pre essay B', 55);
      await submitAndGrade(postAssignmentId, studentTokenB, 'post essay', 82);
      await submitAndGrade(postAssignmentId, studentTokenA, 'post essay', 78);

      const res = await request(app.getHttpServer())
        .get(`/v1/students/${studentAId}/progress`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(res.body.scoreTrends.length).toBeGreaterThanOrEqual(2);
      expect(res.body.summary.totalAnalyses).toBe(0);
      expect(res.body.summary.errorRateChange).toBeNull();
    });

    it('pre-post：配對統計結構完整；同一作業 400；不存在 404', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/v1/classes/${classId}/analytics/pre-post?preAssignmentId=${preAssignmentId}&postAssignmentId=${postAssignmentId}`,
        )
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        pairedCount: 2,
        excludedCount: 0,
        degreesOfFreedom: 1,
        significant: expect.any(Boolean),
        interpretation: expect.any(String),
      });
      expect(res.body.pre).toMatchObject({ mean: expect.any(Number), standardDeviation: expect.any(Number) });
      expect(res.body.tStatistic).toEqual(expect.any(Number));
      expect(res.body.pValue).toBeGreaterThanOrEqual(0);
      expect(res.body.pValue).toBeLessThanOrEqual(1);

      const same = await request(app.getHttpServer())
        .get(
          `/v1/classes/${classId}/analytics/pre-post?preAssignmentId=${preAssignmentId}&postAssignmentId=${preAssignmentId}`,
        )
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(400);
      expect(same.body.error.code).toBe('ANALYTICS_INVALID_ASSIGNMENT_PAIR');

      await request(app.getHttpServer())
        .get(
          `/v1/classes/${classId}/analytics/pre-post?preAssignmentId=00000000-0000-0000-0000-000000000000&postAssignmentId=${postAssignmentId}`,
        )
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(404);

      // 學生不可看
      await request(app.getHttpServer())
        .get(
          `/v1/classes/${classId}/analytics/pre-post?preAssignmentId=${preAssignmentId}&postAssignmentId=${postAssignmentId}`,
        )
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(403);
    });
  });
});
