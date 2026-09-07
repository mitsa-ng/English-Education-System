import { HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter — 統一錯誤格式', () => {
  const filter = new AllExceptionsFilter();

  function normalize(exception: unknown): { status: number; body: unknown } {
    // 直接呼叫 private normalize 進行純函式測試（不經過 HTTP 層）
    const internal = filter as unknown as {
      normalize: (e: unknown) => { status: number; body: unknown };
    };
    return internal.normalize(exception);
  }

  it('AppException（HttpException + code payload）→ 原封輸出 code/message/details', () => {
    const exception = new HttpException(
      { code: 'CLASS_NOT_FOUND', message: '找不到該班級', details: { classId: 'x' } },
      HttpStatus.NOT_FOUND,
    );
    const { status, body } = normalize(exception);
    expect(status).toBe(404);
    expect(body).toEqual({
      error: { code: 'CLASS_NOT_FOUND', message: '找不到該班級', details: { classId: 'x' } },
    });
  });

  it('ValidationPipe 的 BadRequestException → COMMON_VALIDATION_FAILED + details.fields', () => {
    const exception = new HttpException(
      { message: ['password must be longer than or equal to 8 characters'], error: 'Bad Request', statusCode: 400 },
      HttpStatus.BAD_REQUEST,
    );
    const { status, body } = normalize(exception);
    expect(status).toBe(400);
    const error = (body as { error: { code: string; details: { fields: unknown[] } } }).error;
    expect(error.code).toBe('COMMON_VALIDATION_FAILED');
    expect(error.details.fields).toHaveLength(1);
  });

  it('未攔截的例外 → 500 COMMON_INTERNAL_ERROR，不洩漏內部訊息', () => {
    const { status, body } = normalize(new Error('database password is hunter2'));
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'COMMON_INTERNAL_ERROR', message: '伺服器內部錯誤', details: {} },
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
