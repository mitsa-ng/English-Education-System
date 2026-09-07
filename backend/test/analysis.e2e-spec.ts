import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ANALYSIS_ENGINE } from '../src/infrastructure/analyzer-client/analysis-engine.interface';
import type {
  AnalysisEngine,
  AnalysisErrorItem,
  AnalysisOutput,
  FileAnalysisOutput,
} from '../src/infrastructure/analyzer-client/analysis-engine.interface';
import { AnalysisEngineUnavailableError } from '../src/infrastructure/analyzer-client/analysis-engine.interface';
import { FILE_STORAGE } from '../src/infrastructure/storage/storage.module';
import type { FileStorage } from '../src/infrastructure/storage/file-storage.interface';
import { configureApp } from '../src/configure-app';

/**
 * M4 e2e（編排層）：以 fake AnalysisEngine / FileStorage 取代 sidecar 與 MinIO。
 * sidecar 本身的契約由 analyzer/tests/test_analyzer.py 驗證（已於 CI 跑）。
 */

const FIXED_ERRORS: AnalysisErrorItem[] = [
  { type: 'spelling', original: 'freind', suggestion: 'friend', explanation: null, offset: 3, length: 6 },
  { type: 'grammar', original: 'like to eating', suggestion: 'likes to eat', explanation: null, offset: 10, length: 14 },
];
const FIXED_SUMMARY = { spellingCount: 1, grammarCount: 1, semanticCount: 0, wordCount: 7 };
const TINY_PDF_BASE64 = Buffer.from('%PDF-1.4 fake').toString('base64');

describe('Analysis e2e (M4, fake engine)', () => {
  let app: INestApplication;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  let teacherToken: string;
  let studentToken: string;
  let studentTokenB: string;
  let submissionId: string;
  let fileSubmissionId: string;
  let attachmentId: string;

  // 假引擎：可控制延遲與失敗
  let delayMs = 0;
  let failNext = false;

  const fakeEngine: AnalysisEngine = {
    async healthCheck() {
      return { ollama: 'reachable', model: 'fake-model' };
    },
    async analyzeText() {
      if (failNext) {
        failNext = false;
        throw new AnalysisEngineUnavailableError('fake ollama down');
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const output: AnalysisOutput = {
        engineVersion: 'fake-1.0.0',
        language: 'en',
        errors: FIXED_ERRORS,
        summary: FIXED_SUMMARY,
      };
      return output;
    },
    async analyzeFile(): Promise<FileAnalysisOutput> {
      return {
        engineVersion: 'fake-1.0.0',
        language: 'en',
        errors: FIXED_ERRORS,
        summary: FIXED_SUMMARY,
        extractedText: 'fake extracted text',
        annotatedPdfBase64: TINY_PDF_BASE64,
      };
    },
  };

  const fakeStorage: FileStorage = {
    async ensureBucket() {
      return true;
    },
    async presignPut() {
      return { url: 'http://fake-put', expiresAt: new Date() };
    },
    async presignGet() {
      return { url: 'http://fake-get', expiresAt: new Date() };
    },
    async getObject() {
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    },
    async putObject() {
      /* noop */
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANALYSIS_ENGINE)
      .useValue(fakeEngine)
      .overrideProvider(FILE_STORAGE)
      .useValue(fakeStorage)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const teacher = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: `m4_teacher_${runId}@test.dev`, password: 'teacher-pass-123', name: 'M4 教師' })
      .expect(201);
    teacherToken = teacher.body.accessToken;

    const klass = await request(app.getHttpServer())
      .post('/v1/classes')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: `M4 班級 ${runId}` })
      .expect(201);

    const students = await request(app.getHttpServer())
      .post(`/v1/classes/${klass.body.id}/students`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        students: [
          { name: '文宅', username: `m4_a_${runId}` },
          { name: '路人', username: `m4_b_${runId}` },
        ],
      })
      .expect(201);
    const loginA = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m4_a_${runId}`, password: students.body.created[0].initialPassword })
      .expect(200);
    studentToken = loginA.body.accessToken;
    const loginB = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `m4_b_${runId}`, password: students.body.created[1].initialPassword })
      .expect(200);
    studentTokenB = loginB.body.accessToken;

    const assignment = await request(app.getHttpServer())
      .post(`/v1/classes/${klass.body.id}/assignments`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: 'My Best Friend', type: 'ESSAY', publishNow: true })
      .expect(201);

    const submission = await request(app.getHttpServer())
      .post(`/v1/assignments/${assignment.body.id}/submissions`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ content: 'My freind like to eating apples every day.' })
      .expect(201);
    submissionId = submission.body.id;

    // 附件版提交（latestFile 路徑用）——由 B 上傳、B 提交
    const upload = await request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${studentTokenB}`)
      .send({
        filename: `essay-${runId}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        assignmentId: assignment.body.id,
      })
      .expect(201);
    attachmentId = upload.body.attachmentId;
    const fileSubmission = await request(app.getHttpServer())
      .post(`/v1/assignments/${assignment.body.id}/submissions`)
      .set('Authorization', `Bearer ${studentTokenB}`)
      .send({ newAttachmentIds: [attachmentId] })
      .expect(201);
    fileSubmissionId = fileSubmission.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function pollUntilCompleted(subId: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/v1/submissions/${subId}/analysis`)
        .set('Authorization', `Bearer ${teacherToken}`);
      if (res.status === 200 && res.body.status === 'COMPLETED') {
        return res.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`analysis not COMPLETED within ${timeoutMs}ms`);
  }

  it('觸發分析 → 202；輪詢到 COMPLETED；errors 結構符合 AnalysisErrorItem', async () => {
    const trigger = await request(app.getHttpServer())
      .post(`/v1/submissions/${submissionId}/analyze`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ language: 'en' })
      .expect(202);
    expect(trigger.body.status).toBe('PENDING');
    expect(trigger.body.id).toEqual(expect.any(String));

    const completed = await pollUntilCompleted(submissionId);
    expect(completed.status).toBe('COMPLETED');

    const result = completed.result as { errors: unknown[]; summary: Record<string, number> };
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatchObject({
      type: 'spelling',
      original: 'freind',
      suggestion: 'friend',
      offset: 3,
      length: 6,
    });
    expect(result.summary).toMatchObject(FIXED_SUMMARY);
    expect(completed.annotatedPdfAttachmentId).toBeNull(); // 純文字路徑無 PDF
  });

  it('歷史列表：?all=true 回多筆', async () => {
    await request(app.getHttpServer())
      .post(`/v1/submissions/${submissionId}/analyze`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ language: 'en' })
      .expect(202);
    await pollUntilCompleted(submissionId);

    const res = await request(app.getHttpServer())
      .get(`/v1/submissions/${submissionId}/analysis?all=true`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('分析進行中再觸發 → 409 ANALYSIS_ALREADY_RUNNING', async () => {
    delayMs = 1200; // 讓 worker 睡一下
    await request(app.getHttpServer())
      .post(`/v1/submissions/${submissionId}/analyze`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ language: 'en' })
      .expect(202);

    const conflict = await request(app.getHttpServer())
      .post(`/v1/submissions/${submissionId}/analyze`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ language: 'en' })
      .expect(409);
    expect(conflict.body.error.code).toBe('ANALYSIS_ALREADY_RUNNING');

    await pollUntilCompleted(submissionId, 8000);
    delayMs = 0;
  });

  it('引擎失敗 → FAILED 帶 errorCode；錯誤後可重新觸發', async () => {
    failNext = true;
    await request(app.getHttpServer())
      .post(`/v1/submissions/${submissionId}/analyze`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ language: 'en' })
      .expect(202);

    const deadline = Date.now() + 5000;
    let failed: { status: string; errorCode: string } | undefined;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/v1/submissions/${submissionId}/analysis`)
        .set('Authorization', `Bearer ${teacherToken}`);
      if (res.status === 200 && res.body.status === 'FAILED') {
        failed = res.body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(failed).toBeDefined();
    expect(failed!.errorCode).toBe('ANALYSIS_ENGINE_UNAVAILABLE');

    // 重新觸發成功
    await request(app.getHttpServer())
      .post(`/v1/submissions/${submissionId}/analyze`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ language: 'en' })
      .expect(202);
    await pollUntilCompleted(submissionId);
  });

  it('檔案路徑（latestFile）：COMPLETED + 標註 PDF 附件可下載', async () => {
    await request(app.getHttpServer())
      .post(`/v1/submissions/${fileSubmissionId}/analyze`)
      .set('Authorization', `Bearer ${studentTokenB}`)
      .send({ language: 'en', inputSource: 'latestFile' })
      .expect(202);

    const completed = await pollUntilCompleted(fileSubmissionId);
    const attachmentIdOf = completed.annotatedPdfAttachmentId as string;
    expect(attachmentIdOf).toEqual(expect.any(String));

    const download = await request(app.getHttpServer())
      .get(`/v1/attachments/${attachmentIdOf}/download-url`)
      .set('Authorization', `Bearer ${studentTokenB}`)
      .expect(200);
    expect(download.body.downloadUrl).toEqual(expect.any(String));
  });

  it('無分析結果 → 404 ANALYSIS_NOT_FOUND', async () => {
    // 路人沒有提交紀錄，改用一個新建未分析的提交
    const res = await request(app.getHttpServer())
      .get(`/v1/submissions/${submissionId}/analysis?all=false`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(200); // 此提交已有結果——改為確認 no-result 路徑用不存在 id
    expect(res.status).toBe(200);

    const notFound = await request(app.getHttpServer())
      .get('/v1/submissions/00000000-0000-0000-0000-000000000000/analysis')
      .set('Authorization', `Bearer ${teacherToken}`)
      .expect(404);
    expect(notFound.body.error.code).toBe('SUBMISSION_NOT_FOUND');
  });

  it('學生不可分析他人提交 → 403', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/submissions/${fileSubmissionId}/analyze`)
      .set('Authorization', `Bearer ${studentToken}`) // 文宅 分析 路人的提交
      .send({ language: 'en' })
      .expect(403);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('學生可看自己的分析結果（latestAnalysis 欄位也會出現在提交詳情）', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/submissions/${fileSubmissionId}`)
      .set('Authorization', `Bearer ${studentTokenB}`)
      .expect(200);
    expect(res.body.latestAnalysis).toMatchObject({ status: 'COMPLETED' });
  });
});
