/**
 * SSIO 全站统一错误码。
 *
 * 契约：所有 HTTP 错误响应体恒为 `{ error: { code, message, details? } }`。
 * `code` 取自本表，消费方据此分支处理，不可依赖 `message`（文案会变）。
 * 新增错误码必须同步进 `docs/03-API参考.md`（该文档由 `pnpm gen:api-docs` 生成，禁止手写）。
 */
export const ERROR_DEFS = {
  // 4xx
  BAD_REQUEST: { httpStatus: 400, message: '请求格式错误' },
  VALIDATION: { httpStatus: 400, message: '参数校验失败' },
  UNAUTHORIZED: { httpStatus: 401, message: '缺少或无效的凭据' },
  TOKEN_EXPIRED: { httpStatus: 401, message: '令牌已过期' },
  KEY_REVOKED: { httpStatus: 401, message: 'APIKey 已被吊销' },
  KEY_EXPIRED: { httpStatus: 401, message: 'APIKey 已过期' },
  FORBIDDEN: { httpStatus: 403, message: '无权访问该资源' },
  SCOPE_DENIED: { httpStatus: 403, message: 'APIKey 缺少所需 scope' },
  NOT_FOUND: { httpStatus: 404, message: '资源不存在' },
  CONFLICT: { httpStatus: 409, message: '资源冲突' },
  RATE_LIMITED: { httpStatus: 429, message: '请求过于频繁' },
  // 5xx
  QUOTA_EXCEEDED: { httpStatus: 507, message: '存储配额不足' },
  INTERNAL: { httpStatus: 500, message: '服务器内部错误' },
} as const;

export type ErrorCode = keyof typeof ERROR_DEFS;

export const ERROR_CODES = Object.keys(ERROR_DEFS) as ErrorCode[];

/** 错误详情：字段级校验信息或上游原始错误，仅用于排查，消费方不应解析其结构。 */
export type ErrorDetails = Record<string, unknown> | Array<{ field?: string; message: string }>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message?: string, details?: ErrorDetails) {
    super(message ?? ERROR_DEFS[code].message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_DEFS[code].httpStatus;
    if (details !== undefined) this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: ErrorDetails } } {
    const payload: { error: { code: ErrorCode; message: string; details?: ErrorDetails } } = {
      error: { code: this.code, message: this.message },
    };
    if (this.details !== undefined) payload.error.details = this.details;
    return payload;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
