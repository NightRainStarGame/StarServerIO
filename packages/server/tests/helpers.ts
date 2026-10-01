import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import type { AppRecord } from '@ssio/shared';
import { openDatabase, type Db, type Sqlite } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { configForTest, type ServerConfig } from '../src/env.js';
import { buildApp } from '../src/app.js';

export interface TestServer {
  app: FastifyInstance;
  request: supertest.Agent;
  masterKey: string;
  dataDir: string;
  /** 暴露裸连接，供「数据库里没有明文」这类断言直接查表。 */
  sqlite: Sqlite;
  /** drizzle 实例：sweep / cleanupRefreshTokens 这类内部函数的测试要用。 */
  db: Db;
  config: ServerConfig;
  cleanup: () => void;
}

/**
 * 起一个真实的服务端实例（Supertest 打真实 HTTP 栈），数据落在 os.tmpdir()。
 *
 * 测试**绝不允许**碰开发库 —— 每个用例一个临时目录，跑完删除。
 */
export async function createTestServer(overrides: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ssio-test-'));
  const { db, sqlite } = openDatabase(join(dataDir, 'ssio.db'));
  runMigrations(db);

  const config = configForTest({
    dataDir,
    // 默认放宽限流，避免审计类用例被限流干扰；限流单独在 ratelimit.test.ts 里验证
    RATE_LIMIT_MAX: '10000',
    ...overrides,
  });

  const app = await buildApp({ db, config });
  // 必须自己 listen：否则 supertest 会在每次请求后把它自己起的服务关掉，
  // 后续请求拿到 ECONNREFUSED（表现为随机的连接失败）
  await app.listen({ port: 0, host: '127.0.0.1' });
  const request = supertest(app.server);

  return {
    app,
    request,
    masterKey: config.MASTER_KEY,
    dataDir,
    sqlite,
    db,
    config,
    cleanup: () => {
      void app.close();
      sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createApp(request: supertest.Agent, masterKey: string, slug: string, name?: string): Promise<AppRecord> {
  const res = await request
    .post('/v1/apps')
    .set('X-Master-Key', masterKey)
    .send({ slug, name: name ?? slug });
  expect201(res);
  return res.body as AppRecord;
}

export async function issueKey(
  request: supertest.Agent,
  masterKey: string,
  opts: { appId: string; name?: string; scopes: string[]; expiresAt?: number | null },
): Promise<string> {
  const res = await request
    .post('/v1/keys')
    .set('X-Master-Key', masterKey)
    .send({ appId: opts.appId, name: opts.name ?? 'test-key', scopes: opts.scopes, expiresAt: opts.expiresAt ?? null });
  expect201(res);
  return res.body.key as string;
}

export function expect201(res: supertest.Response): void {
  if (res.status !== 201) {
    throw new Error(`期望 201，实际 ${res.status}：${JSON.stringify(res.body)}`);
  }
}
