import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db/client.js';
import type { ServerConfig } from './env.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerRateLimit } from './plugins/rateLimit.js';
import { registerAuth } from './plugins/auth.js';
import { registerHealth } from './modules/health.js';
import { registerApps } from './modules/apps.js';
import { registerApiKeys } from './modules/apikeys.js';
import { registerAuth as registerAuthRoutes } from './modules/auth.js';
import { registerUsers } from './modules/users.js';

export interface BuildAppOptions {
  db: Db;
  config: ServerConfig;
}

/**
 * 构造 Fastify 实例。
 *
 * 导出它而不是只在 index.ts 里 listen，是为了让集成测试用 Supertest 打**真实的路由栈**
 * （含鉴权、限流、错误映射），而不是只测模块内部函数。
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config } = opts;

  const app = Fastify({
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL },
    // 统一信任代理，便于后面按真实客户端 IP 限流与审计
    trustProxy: true,
    ajv: {
      customOptions: {
        // 只允许数组 coercion。默认的 coerceTypes:true 会把 `expiresAt: null` 悄悄转成 0，
        // 导致「永不过期」的 APIKey 被判定为已过期 —— 这类静默类型篡改必须关掉
        coerceTypes: 'array',
        removeAdditional: false,
        useDefaults: true,
      },
    },
  });

  registerErrorHandler(app);
  await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') });
  await registerRateLimit(app, config);
  registerAuth(app, db, config);

  const moduleOpts = { db, config };
  await app.register(async (instance) => {
    await registerHealth(instance, moduleOpts);
    await registerApps(instance, moduleOpts);
    await registerApiKeys(instance, moduleOpts);
    await registerAuthRoutes(instance, moduleOpts);
    await registerUsers(instance, moduleOpts);
  });

  await app.ready();
  return app;
}
