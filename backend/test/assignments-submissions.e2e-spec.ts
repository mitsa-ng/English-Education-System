import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/database/prisma.module';
import { configureApp } from '../src/configure-app';

/**
 * M3 e2e：作業狀態機、學生提交/重提交、全班提交狀況（PENDING 合成）、
 * 評分與發還鎖定、presigned 上傳驗證。
 * MinIO 不需在線（presign 為本地計算）；僅驗 URL 形狀與 DB 附件紀錄。
 */

describe('Assignments & Submissions e2e (M3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  let teacherToken: string;
  let studentTokenA: string;
  let studentTokenB: string;
  let studentAId: string;
  let classId: string;
  let assignmentId: string;
  let draftAssignmentId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const teacher = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: `m3_teacher_${runId}@test.dev`, password: 'teacher-pass-123', name: 'M3 教師' })
      .expect(201);
    teacherToken = teacher.body.accessToken;

    const klass = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: `M3 班級 ${runId}` })
      .expect(201);
    classId = klass.body.id;

    const students = await request(app.getHttpServer())
      .post(`/v1/classes/${classId}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        students: [
          { name: '生甲', username: `m3_a_${runId}` },
          { name: '生乙', username: `m3_b_${runId}` },
        ],
      })
      .expect(201);
    studentAId = students.body.created[0].studentId;

    const loginA = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m3_a_${runId}`, password: students.body.created[0].initialPassword })
      .expect(200);
    studentTokenA = loginA.body.accessToken;
    const loginB = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m3_b_${runId}`, password: students.body.created[1].initialPassword })
      .expect(200);
    studentTokenB = loginB.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('作業狀態機', () => {
    it('建立 DRAFT 作業：學生不可見', async () => {
      const created = await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/assignments`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ title: '第一篇作文', type: 'ESSAY', description: '寫 120 字' })
        .expect(201);
      expect(created.body.status).toBe('DRAFT');
      expect(created.body.type).toBe('ESSAY');
      assignmentId = created.body.id;

      const studentView = await request(app.getHttpServer())
        .get(`/v1/classes/${classId}/assignments`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(studentView.body.data).toHaveLength(0);

      await request(app.getHttpServer())
        .get(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(404);
    });

    it('DRAFT→CLOSED 非法轉換 → 409 ASSIGNMENT_INVALID_TRANSITION', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'CLOSED' })
        .expect(409);
      expect(res.body.error.code).toBe('ASSIGNMENT_INVALID_TRANSITION');
    });

    it('發佈 → 學生可見；關閉 → 重開', async () => {
      await request(app.getHttpServer())
        .patch(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);

      const studentView = await request(app.getHttpServer())
        .get(`/v1/classes/${classId}/assignments`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(studentView.body.data).toHaveLength(1);

      await request(app.getHttpServer())
        .patch(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'CLOSED' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);
    });

    it('學生對作業操作：建作業 403（角色）', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/assignments`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .send({ title: '學生的作業', type: 'GENERAL' })
        .expect(403);
      expect(res.body.error.code).toBe('AUTH_ROLE_NOT_ALLOWED');
    });
  });

  describe('提交與重提交', () => {
    it('學生 A 提交本文（201）；重新提交覆蓋（同 submissionId）', async () => {
      const first = await request(app.getHttpServer())
        .post(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .send({ content: 'My freind like apples.' })
        .expect(201);
      expect(first.body.status).toBe('SUBMITTED');
      expect(first.body.content).toBe('My freind like apples.');

      const second = await request(app.getHttpServer())
        .post(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .send({ content: 'My friend likes apples.' })
        .expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.content).toBe('My friend likes apples.');
    });

    it('空提交 → 400', async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({})
        .expect(400);
      expect(res.body.error.code).toBe('COMMON_VALIDATION_FAILED');
    });

    it('作業 CLOSE 後提交 → 409 SUBMISSION_NOT_ACCEPTABLE', async () => {
      // 先關閉
      await request(app.getHttpServer())
        .patch(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'CLOSED' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({ content: 'late submission' })
        .expect(409);
      expect(res.body.error.code).toBe('SUBMISSION_NOT_ACCEPTABLE');

      // 重開供後續測試
      await request(app.getHttpServer())
        .patch(`/v1/assignments/${assignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);
    });
  });

  describe('全班提交狀況（PENDING 合成）', () => {
    it('教師視角：生甲 SUBMITTED、生乙 PENDING；status 篩選與分頁 envelope', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);

      expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, total: 2 });
      const names = res.body.data.map((r: { name: string }) => r.name);
      expect(names.sort()).toEqual(['生乙', '生甲']); // 碼位排序，與業務無關
      const pendingRow = res.body.data.find((r: { name: string }) => r.name === '生乙');
      expect(pendingRow.status).toBe('PENDING');
      expect(pendingRow.submissionId).toBeNull();
      const submittedRow = res.body.data.find((r: { name: string }) => r.name === '生甲');
      expect(submittedRow.status).toBe('SUBMITTED');

      const onlyPending = await request(app.getHttpServer())
        .get(`/v1/assignments/${assignmentId}/submissions?status=PENDING`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(200);
      expect(onlyPending.body.data).toHaveLength(1);

      // 學生不可看全班狀況
      await request(app.getHttpServer())
        .get(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(403);
    });

    it('學生看自己的提交；看他人的 → 403', async () => {
      const own = await request(app.getHttpServer())
        .get(`/v1/submissions/${(await mySubmissionId(studentAId))}`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .expect(200);
      expect(own.body.studentId).toBe(studentAId);

      await request(app.getHttpServer())
        .get(`/v1/submissions/${(await mySubmissionId(studentAId))}`)
        .set('Authorization', `Bearer ${studentTokenB}`)
        .expect(403);
    });
  });

  describe('評分與發還', () => {
    it('評分 → GRADED；學生重提交被拒；發還 → RETURNED；再評分 409', async () => {
      const submissionId = await mySubmissionId(studentAId);

      const graded = await request(app.getHttpServer())
        .patch(`/v1/submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ grade: 85.5, feedback: '拼字注意 friend' })
        .expect(200);
      expect(graded.body.status).toBe('GRADED');
      expect(graded.body.grade).toBe(85.5);

      const resubmit = await request(app.getHttpServer())
        .post(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenA}`)
        .send({ content: '改過了' })
        .expect(409);
      expect(resubmit.body.error.code).toBe('SUBMISSION_NOT_ACCEPTABLE');

      await request(app.getHttpServer())
        .patch(`/v1/submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ returnToStudent: true })
        .expect(200);

      const again = await request(app.getHttpServer())
        .patch(`/v1/submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ grade: 90 })
        .expect(409);
      expect(again.body.error.code).toBe('SUBMISSION_ALREADY_RETURNED');

      // 學生不可評分
      await request(app.getHttpServer())
        .patch(`/v1/submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({ grade: 100 })
        .expect(403);
    });
  });

  describe('上傳（presigned）', () => {
    it('白名單內檔案 → 201 含 presigned PUT URL 與 attachmentId', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({
          filename: `essay-${runId}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          assignmentId,
        })
        .expect(201);

      expect(res.body.attachmentId).toEqual(expect.any(String));
      expect(res.body.uploadUrl).toMatch(/^https?:\/\//);
      expect(res.body.uploadUrl).toContain('X-Amz-Signature');
      expect(res.body.expiresAt).toEqual(expect.any(String));
    });

    it('副檔名不在白名單 → 400 ATTACHMENT_REJECTED', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({ filename: 'virus.exe', mimeType: 'application/x-msdownload', sizeBytes: 10, assignmentId })
        .expect(400);
      expect(res.body.error.code).toBe('ATTACHMENT_REJECTED');
    });

    it('超過 20MB → 400（DTO 驗證）', async () => {
      await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({ filename: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 21 * 1024 * 1024, assignmentId })
        .expect(400);
    });

    it('提交帶附件：附件改掛 submission；下載 URL 可簽發', async () => {
      const upload = await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({
          filename: `my-essay-${runId}.txt`,
          mimeType: 'text/plain',
          sizeBytes: 32,
          assignmentId,
        })
        .expect(201);
      const attachmentId = upload.body.attachmentId as string;

      const submission = await request(app.getHttpServer())
        .post(`/v1/assignments/${assignmentId}/submissions`)
        .set('Authorization', `Bearer ${studentTokenB}`)
        .send({ content: 'essay with attachment', newAttachmentIds: [attachmentId] })
        .expect(201);
      expect(submission.body.attachments).toHaveLength(1);
      expect(submission.body.attachments[0].id).toBe(attachmentId);

      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(row.submissionId).toBe(submission.body.id);
      expect(row.assignmentId).toBeNull();

      const download = await request(app.getHttpServer())
        .get(`/v1/attachments/${attachmentId}/download-url`)
        .set('Authorization', `Bearer ${studentTokenB}`)
        .expect(200);
      expect(download.body.downloadUrl).toMatch(/^https?:\/\//);
      expect(download.body.downloadUrl).toContain('X-Amz-Signature');

      // 他班學生（未選課）不可下載 → 這裡用未加入任何班的學生近似：生甲已選課可下載說明附件，
      // 改驗下載不存在的附件 → 404
      await request(app.getHttpServer())
        .get('/v1/attachments/00000000-0000-0000-0000-000000000000/download-url')
        .set('Authorization', `Bearer ${studentTokenB}`)
        .expect(404);
    });
  });

  describe('封存作業', () => {
    it('封存後列表消失、詳情 404（軟刪除）', async () => {
      const draft = await request(app.getHttpServer())
        .post(`/v1/classes/${classId}/assignments`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ title: '草稿作業', type: 'GENERAL' })
        .expect(201);
      draftAssignmentId = draft.body.id;

      await request(app.getHttpServer())
        .delete(`/v1/assignments/${draftAssignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/v1/assignments/${draftAssignmentId}`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .expect(404);
    });
  });

  async function mySubmissionId(studentId: string): Promise<string> {
    const row = await prisma.submission.findUniqueOrThrow({
      where: { assignmentId_studentId: { assignmentId, studentId } },
      select: { id: true },
    });
    return row.id;
  }
});
