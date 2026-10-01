import type { FastifyInstance } from 'fastify';
import { AppError, isAppError } from '@ssio/shared';

/**
 * 统一错误结构：`{ error: { code, message, details? } }`。
 *
 * 三类来源归一：
 * 1. 业务主动抛的 AppError；
 * 2. Fastify schema 校验失败（FST_ERR_VALIDATION）→ VALIDATION；
 * 3. 限流插件抛的 429 → RATE_LIMITED。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (isAppError(err)) {
      void reply.code(err.httpStatus).send(err.toJSON());
      return;
    }

    const anyErr = err as { statusCode?: number; code?: string; validation?: unknown; message?: string };

    // 请求体不是合法 JSON：这是客户端错误，必须给 400。
    // 不单独处理的话会掉进下面的 500 分支，把「用户发错格式」伪装成「服务端故障」。
    if (anyErr.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      void reply.code(400).send(new AppError('BAD_REQUEST', '请求体不是合法 JSON').toJSON());
      return;
    }

    if (anyErr.code === 'FST_ERR_VALIDATION' || anyErr.validation !== undefined) {
      void reply.code(400).send(
        new AppError('VALIDATION', '参数校验失败', { details: anyErr.validation as never }).toJSON(),
      );
      return;
    }

    if (anyErr.statusCode === 429) {
      void reply.code(429).send(new AppError('RATE_LIMITED').toJSON());
      return;
    }

    req.log.error({ err: anyErr }, 'unhandled error');
    void reply.code(500).send(new AppError('INTERNAL').toJSON());
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(new AppError('NOT_FOUND', `路由不存在: ${req.method} ${req.url}`).toJSON());
  });
}
