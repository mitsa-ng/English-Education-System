import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export interface ErrorDetailValue {
  [key: string]: unknown;
}

/**
 * 統一業務例外：攜帶機器可讀 code + 人類可讀 message + 上下文 details。
 * 所有 service 拋出此類；由 AllExceptionsFilter 轉成
 * `{ error: { code, message, details } }` 回應格式。
 */
export class AppException extends HttpException {
  readonly errorCode: ErrorCode;
  readonly errorDetails: ErrorDetailValue;

  constructor(
    status: HttpStatus,
    errorCode: ErrorCode,
    message: string,
    details: ErrorDetailValue = {},
  ) {
    super({ code: errorCode, message, details }, status);
    this.errorCode = errorCode;
    this.errorDetails = details;
    this.name = 'AppException';
  }

  static badRequest(code: ErrorCode, message: string, details?: ErrorDetailValue) {
    return new AppException(HttpStatus.BAD_REQUEST, code, message, details);
  }
  static unauthorized(code: ErrorCode, message: string, details?: ErrorDetailValue) {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message, details);
  }
  static forbidden(message = '無權存取此資源', details?: ErrorDetailValue) {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.AUTH_FORBIDDEN, message, details);
  }
  static notFound(code: ErrorCode, message: string, details?: ErrorDetailValue) {
    return new AppException(HttpStatus.NOT_FOUND, code, message, details);
  }
  static conflict(code: ErrorCode, message: string, details?: ErrorDetailValue) {
    return new AppException(HttpStatus.CONFLICT, code, message, details);
  }
  static gone(code: ErrorCode, message: string, details?: ErrorDetailValue) {
    return new AppException(HttpStatus.GONE, code, message, details);
  }
}
