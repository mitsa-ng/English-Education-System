import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type Response } from 'express';
import { ErrorCode } from '../errors/error-codes';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

/**
 * 全域例外過濾器：任何錯誤（含未攔截例外）都走統一格式
 * { error: { code, message, details } }（make error useful）。
 * details 只放資源 ID 等上下文，永遠不含密碼、token、作文內容。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ id?: string; method: string; url: string }>();

    const { status, body } = this.normalize(exception);

    const logPayload = {
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: status,
      errorCode: body.error.code,
    };
    if (status >= 500) {
      this.logger.error({ ...logPayload, stack: this.stackOf(exception) }, 'unhandled exception');
    } else {
      this.logger.warn(logPayload, body.error.message);
    }

    response.status(status).json(body);
  }

  private normalize(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // AppException：response 是我們自己的 { code, message, details }
      if (typeof payload === 'object' && payload !== null && 'code' in payload) {
        const { code, message, details } = payload as {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
        return {
          status,
          body: { error: { code, message, details: details ?? {} } },
        };
      }

      // class-validator 的 BadRequestException：message 是陣列
      const message = exception.message;
      const details =
        status === HttpStatus.BAD_REQUEST
          ? { fields: Array.isArray((payload as { message?: unknown })?.message)
              ? ((payload as { message: unknown[] }).message as unknown[])
              : [message] }
          : {};
      return {
        status,
        body: {
          error: {
            code:
              status === HttpStatus.BAD_REQUEST
                ? ErrorCode.COMMON_VALIDATION_FAILED
                : ErrorCode.COMMON_INTERNAL_ERROR,
            message: status === HttpStatus.BAD_REQUEST ? '請求參數驗證失敗' : message,
            details,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: ErrorCode.COMMON_INTERNAL_ERROR,
          message: '伺服器內部錯誤',
          details: {},
        },
      },
    };
  }

  private stackOf(exception: unknown): string | undefined {
    return exception instanceof Error ? exception.stack : undefined;
  }
}
