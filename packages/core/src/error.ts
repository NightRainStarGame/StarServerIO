/**
 * SDK 错误归一化。
 *
 * 服务端的错误体是 `{ error: { code, message, details } }`，
 * SDK 把它连同 HTTP 状态一起装进 `SsioError`，调用方只需要 catch 一种类型。
 */

export class SsioError extends Error {
  /** 服务端错误码（如 UNAUTHORIZED / SCOPE_DENIED）；网络层错误用 NETWORK / TIMEOUT。 */
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(code: string, message: string, httpStatus: number, details?: unknown, cause?: unknown) {
    super(message);
    this.name = 'SsioError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.cause = cause;
  }
}

/** refresh 链断了（refresh token 失效/被吊销）：需要引导用户重新登录。 */
export class AuthError extends SsioError {
  constructor(message: string, httpStatus = 401, cause?: unknown) {
    super('AUTH_EXPIRED', message, httpStatus, undefined, cause);
    this.name = 'AuthError';
  }
}
