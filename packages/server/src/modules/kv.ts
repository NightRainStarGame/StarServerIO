import { Type } from '@sinclair/typebox';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@ssio/shared';
import { kvEntries } from '../db/schema.js';
import { newId } from '../db/client.js';
import type { ModuleOptions } from '../types.js';

/** 单条 value 上限 1 MiB：KV 面向结构化数据（班级/作业/配置），不是网盘。 */
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_KEY_LEN = 512;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

const KvSchema = Type.Object({
  key: Type.String(),
  value: Type.String(),
  version: Type.Integer(),
  sizeBytes: Type.Integer(),
  updatedAt: Type.Integer(),
});

const PutBody = Type.Object({
  value: Type.String({ maxLength: MAX_VALUE_BYTES }),
  /** 乐观锁：带了这个值且与服务端的 version 不一致 → 409，避免并发覆盖 */
  expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
});

/**
 * 启动时保证表存在（幂等）。
 *
 * 为什么不走 drizzle-kit 迁移：本模块是后期增补，线上库已经跑过 0000~0002，
 * 重新 generate 需要工具链；这里用 IF NOT EXISTS 兜底，无论迁移跑到哪一版
 * 都能自愈，且不会破坏已有数据。
 */
function ensureTable(db: ModuleOptions['db']): void {
  db.run(sql`CREATE TABLE IF NOT EXISTS kv_entries (
    id text PRIMARY KEY NOT NULL,
    app_id text NOT NULL,
    "key" text NOT NULL,
    value text NOT NULL,
    size_bytes integer NOT NULL,
    version integer NOT NULL DEFAULT 1,
    updated_at integer NOT NULL,
    created_at integer NOT NULL
  )`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_kv_app_key ON kv_entries (app_id, "key")`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_kv_app_key ON kv_entries (app_id, "key")`);
}

/**
 * KV 存储：给业务方一个「多端共享的轻量 JSON 文档」。
 *
 * 设计要点：
 * - key 全程用 query 传（不用路径参数），避免 `/` 分层键被路由吃掉；
 * - 写入是 upsert，version 单调递增，支持 expectedVersion 乐观锁；
 * - 鉴权复用 storage scope，已有业务 APIKey 直接可用。
 */
export async function registerKv(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db } = opts;
  ensureTable(db);

  function readKey(req: unknown): string {
    const q = (req as { query?: Record<string, unknown> }).query ?? {};
    const key = typeof q.key === 'string' ? q.key : '';
    if (!key) throw new AppError('VALIDATION', '缺少 key 参数');
    if (key.length > MAX_KEY_LEN) throw new AppError('VALIDATION', `key 过长（上限 ${MAX_KEY_LEN}）`);
    return key;
  }

  // 读单条
  app.get(
    '/v1/kv',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:read'] })],
      schema: {
        querystring: Type.Object({ key: Type.String({ minLength: 1 }) }),
        response: { 200: KvSchema },
      },
    },
    async (req) => {
      const key = readKey(req);
      const row = db
        .select()
        .from(kvEntries)
        .where(and(eq(kvEntries.appId, req.ctx.appId!), eq(kvEntries.key, key)))
        .get();
      if (!row) throw new AppError('NOT_FOUND', 'key 不存在');
      return {
        key: row.key,
        value: row.value,
        version: row.version,
        sizeBytes: row.sizeBytes,
        updatedAt: row.updatedAt,
      };
    },
  );

  // 写（upsert）
  app.put(
    '/v1/kv',
    {
      // value 最大 1 MiB，Fastify 默认 bodyLimit 1 MiB 刚好卡边界，放宽一档
      bodyLimit: MAX_VALUE_BYTES + 64 * 1024,
      preHandler: [app.requireApiKey({ scopes: ['storage:write'] })],
      schema: {
        querystring: Type.Object({ key: Type.String({ minLength: 1, maxLength: MAX_KEY_LEN }) }),
        body: PutBody,
        response: {
          200: Type.Object({ key: Type.String(), version: Type.Integer(), updatedAt: Type.Integer(), sizeBytes: Type.Integer() }),
        },
      },
    },
    async (req) => {
      const key = readKey(req);
      const body = req.body as { value: string; expectedVersion?: number };
      const sizeBytes = Buffer.byteLength(body.value, 'utf8');
      if (sizeBytes > MAX_VALUE_BYTES) {
        throw new AppError('VALIDATION', `value 超过 ${MAX_VALUE_BYTES} 字节上限`);
      }

      const appId = req.ctx.appId!;
      const now = Date.now();
      const existing = db
        .select()
        .from(kvEntries)
        .where(and(eq(kvEntries.appId, appId), eq(kvEntries.key, key)))
        .get();

      if (existing) {
        if (body.expectedVersion != null && body.expectedVersion !== existing.version) {
          throw new AppError('CONFLICT', '版本冲突：该条目已被其它客户端更新，请重新拉取后再写', {
            currentVersion: existing.version,
          });
        }
        const nextVersion = existing.version + 1;
        db.update(kvEntries)
          .set({ value: body.value, sizeBytes, version: nextVersion, updatedAt: now })
          .where(eq(kvEntries.id, existing.id))
          .run();
        return { key, version: nextVersion, updatedAt: now, sizeBytes };
      }

      const row = {
        id: newId(),
        appId,
        key,
        value: body.value,
        sizeBytes,
        version: 1,
        updatedAt: now,
        createdAt: now,
      };
      db.insert(kvEntries).values(row).run();
      return { key, version: 1, updatedAt: now, sizeBytes };
    },
  );

  // 删
  app.delete(
    '/v1/kv',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:write'] })],
      schema: {
        querystring: Type.Object({ key: Type.String({ minLength: 1, maxLength: MAX_KEY_LEN }) }),
        response: { 200: Type.Object({ deleted: Type.Boolean(), key: Type.String() }) },
      },
    },
    async (req) => {
      const key = readKey(req);
      const res = db
        .delete(kvEntries)
        .where(and(eq(kvEntries.appId, req.ctx.appId!), eq(kvEntries.key, key)))
        .run();
      return { deleted: (res.changes ?? 0) > 0, key };
    },
  );

  // 列举（按前缀）
  app.get(
    '/v1/kv/list',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:read'] })],
      schema: {
        querystring: Type.Object({
          prefix: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT })),
        }),
        response: {
          200: Type.Object({
            items: Type.Array(
              Type.Object({ key: Type.String(), version: Type.Integer(), sizeBytes: Type.Integer(), updatedAt: Type.Integer() }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const q = req.query as { prefix?: string; limit?: number };
      const appId = req.ctx.appId!;
      const limit = q.limit ?? DEFAULT_LIST_LIMIT;
      const prefix = q.prefix ?? '';

      const rows = prefix
        ? db
            .select({
              key: kvEntries.key,
              version: kvEntries.version,
              sizeBytes: kvEntries.sizeBytes,
              updatedAt: kvEntries.updatedAt,
            })
            .from(kvEntries)
            .where(and(eq(kvEntries.appId, appId), like(kvEntries.key, `${prefix}%`)))
            .orderBy(asc(kvEntries.key))
            .limit(limit)
            .all()
        : db
            .select({
              key: kvEntries.key,
              version: kvEntries.version,
              sizeBytes: kvEntries.sizeBytes,
              updatedAt: kvEntries.updatedAt,
            })
            .from(kvEntries)
            .where(eq(kvEntries.appId, appId))
            .orderBy(asc(kvEntries.key))
            .limit(limit)
            .all();

      return { items: rows };
    },
  );
}
