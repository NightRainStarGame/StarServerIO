import { join } from 'node:path';
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
import { registerAuth as registerAuthRoutes, cleanupRefreshTokens } from './modules/auth.js';
import { registerUsers } from './modules/users.js';
import { registerStorage } from './modules/storage.js';
import { registerReleases } from './modules/releases.js';
import { registerCards } from './modules/cards.js';
import { registerAnnouncements } from './modules/announcements.js';
import { registerForum } from './modules/forum.js';
import { registerRegistry } from './modules/registry.js';
import { registerKv } from './modules/kv.js';
import { LocalDriver } from './storage/local.js';
import { StorageService } from './storage/service.js';
import type { StorageDriver } from './storage/driver.js';
import type { ModuleOptions } from './types.js';

export interface BuildAppOptions {
  db: Db;
  config: ServerConfig;
  /** 注入自定义驱动（测试用）。缺省时使用本地文件系统驱动。 */
  driver?: StorageDriver;
  /**
   * 启动轻量定时清理（过期上传会话 + 过期/已吊销 refresh token）。
   * 生产入口（index.ts）应提供；测试不提供，避免每个用例都挂一个定时器。
   */
  janitorIntervalMs?: number;
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

  // 存储：对象一律落在 DATA_DIR/storage，绝不放在源码目录里
  const driver =
    opts.driver ?? new LocalDriver({ root: join(config.dataDir, 'storage'), signSecret: config.JWT_SECRET });
  const storage = new StorageService(db, driver, config.dataDir);

  const moduleOpts: ModuleOptions = { db, config, storage };
  await app.register(async (instance) => {
    await registerHealth(instance, moduleOpts);
    await registerApps(instance, moduleOpts);
    await registerApiKeys(instance, moduleOpts);
    await registerAuthRoutes(instance, moduleOpts);
    await registerUsers(instance, moduleOpts);
    await registerStorage(instance, moduleOpts);
    await registerReleases(instance, moduleOpts);
    await registerCards(instance, moduleOpts);
    await registerAnnouncements(instance, moduleOpts);
    await registerForum(instance, moduleOpts);
    await registerRegistry(instance, moduleOpts);
    // P10：KV（TaskManager 的班级 / 作业同步用它做多端结构化数据共享）
    await registerKv(instance, moduleOpts);
  });

  if (opts.janitorIntervalMs !== undefined) {
    const sweep = (): void => {
      // 单项失败不影响另一项，下一轮再试
      try {
        storage.sweepExpiredSessions();
      } catch {
        /* noop */
      }
      try {
        cleanupRefreshTokens(db);
      } catch {
        /* noop */
      }
    };
    sweep(); // 启动即清一次
    const timer = setInterval(sweep, opts.janitorIntervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => {
      clearInterval(timer);
    });
  }

  await app.ready();
  return app;
}
