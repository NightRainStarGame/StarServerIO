import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, validateScopes, type ApiKeyIssued } from '@ssio/shared';
import { apiKeys, apps } from '../db/schema.js';
import { newId } from '../db/client.js';
import { writeAudit } from '../lib/audit.js';
import { generateApiKey, hashApiKey, maskApiKey } from '../lib/keys.js';
import { NullableInteger, NullableNumber } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const KeySchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  name: Type.String(),
  keyPrefix: Type.String(),
  masked: Type.String(),
  scopes: Type.Array(Type.String()),
  expiresAt: NullableNumber(),
  lastUsedAt: NullableNumber(),
  revokedAt: NullableNumber(),
  createdAt: Type.Integer(),
});

const IssueSchema = Type.Intersect([KeySchema, Type.Object({ key: Type.String() })]);

const CreateKeyBody = Type.Object({
  appId: Type.Optional(Type.String()),
  appSlug: Type.Optional(Type.String()),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  scopes: Type.Array(Type.String(), { minItems: 1 }),
  expiresAt: Type.Optional(NullableInteger()),
});

const UpdateKeyBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  scopes: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
});

function toKeyRecord(r: typeof apiKeys.$inferSelect) {
  return {
    id: r.id,
    appId: r.appId,
    name: r.name,
    keyPrefix: r.keyPrefix,
    masked: maskApiKey(r.keyPrefix),
    scopes: r.scopes,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  };
}

/**
 * APIKey 签发 / 列表 / 吊销。
 *
 * 只有 Master Key 能签发 —— 否则任何一把 `admin:*` 的 Key 都能给自己开新 Key，权限会失控。
 */
export async function registerApiKeys(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db } = opts;

  app.post(
    '/v1/keys',
    { preHandler: [app.requireMaster()], schema: { body: CreateKeyBody, response: { 201: IssueSchema } } },
    async (req, reply) => {
      const body = req.body as {
        appId?: string;
        appSlug?: string;
        name: string;
        scopes: string[];
        expiresAt?: number | null;
      };

      const target = body.appId
        ? db.select().from(apps).where(eq(apps.id, body.appId)).get()
        : body.appSlug
          ? db.select().from(apps).where(eq(apps.slug, body.appSlug)).get()
          : undefined;
      if (!target) throw new AppError('NOT_FOUND', '应用不存在（需提供 appId 或 appSlug）');

      const unknown = validateScopes(body.scopes);
      if (unknown.length > 0) throw new AppError('VALIDATION', '存在未知 scope', { unknown });

      const { key, keyPrefix } = generateApiKey();
      const row = {
        id: newId(),
        appId: target.id,
        name: body.name,
        keyHash: hashApiKey(key),
        keyPrefix,
        scopes: body.scopes,
        expiresAt: body.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: Date.now(),
      };
      db.insert(apiKeys).values(row).run();

      writeAudit(db, {
        appId: target.id,
        actorType: 'master',
        action: 'key.issue',
        target: row.id,
        ip: req.ip,
        // 只记前缀，明文永不落盘、永不进日志
        meta: { name: row.name, keyPrefix: row.keyPrefix, scopes: row.scopes },
      });

      const issued: ApiKeyIssued = {
        id: row.id,
        appId: row.appId,
        name: row.name,
        keyPrefix: row.keyPrefix,
        scopes: row.scopes,
        expiresAt: row.expiresAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
        key,
      };
      void reply.code(201);
      return { ...issued, masked: maskApiKey(row.keyPrefix) };
    },
  );

  app.get(
    '/v1/keys',
    {
      preHandler: [app.requireMaster()],
      schema: { querystring: Type.Object({ appId: Type.Optional(Type.String()) }), response: { 200: Type.Array(KeySchema) } },
    },
    async (req) => {
      const { appId } = req.query as { appId?: string };
      const rows = appId
        ? db.select().from(apiKeys).where(eq(apiKeys.appId, appId)).all()
        : db.select().from(apiKeys).all();
      return rows.map((r) => ({
        id: r.id,
        appId: r.appId,
        name: r.name,
        keyPrefix: r.keyPrefix,
        masked: maskApiKey(r.keyPrefix),
        scopes: r.scopes,
        expiresAt: r.expiresAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        createdAt: r.createdAt,
      }));
    },
  );

  // 调整已签发 Key 的 scope。存在意义：权限模型细化时（例如把 delete 从 write 里
  // 拆出来）老 Key 会突然缺少新 scope，必须有一条不改明文、只补权限的迁移通道，
  // 否则只能吊销重签 —— 而重签意味着所有客户端都要换 Key。
  app.patch(
    '/v1/keys/:id',
    {
      preHandler: [app.requireMaster()],
      schema: { body: UpdateKeyBody, response: { 200: KeySchema } },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as { name?: string; scopes?: string[] };
      const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
      if (!row) throw new AppError('NOT_FOUND', 'APIKey 不存在');
      if (row.revokedAt !== null) throw new AppError('CONFLICT', 'APIKey 已被吊销，无法调整');

      if (body.scopes) {
        const unknown = validateScopes(body.scopes);
        if (unknown.length > 0) throw new AppError('VALIDATION', '存在未知 scope', { unknown });
      }

      const patch: Partial<typeof apiKeys.$inferInsert> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.scopes !== undefined) patch.scopes = body.scopes;
      if (Object.keys(patch).length === 0) return toKeyRecord(row);

      db.update(apiKeys).set(patch).where(eq(apiKeys.id, id)).run();
      writeAudit(db, {
        appId: row.appId,
        actorType: 'master',
        action: 'key.update',
        target: id,
        ip: req.ip,
        meta: { keyPrefix: row.keyPrefix, scopesBefore: row.scopes, scopesAfter: patch.scopes ?? row.scopes },
      });

      const updated = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
      return toKeyRecord(updated!);
    },
  );

  app.delete(
    '/v1/keys/:id',
    {
      preHandler: [app.requireMaster()],
      schema: {
        response: { 200: Type.Object({ revoked: Type.Literal(true), id: Type.String(), keyPrefix: Type.String() }) },
      },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
      if (!row) throw new AppError('NOT_FOUND', 'APIKey 不存在');
      if (row.revokedAt !== null) throw new AppError('CONFLICT', 'APIKey 已被吊销');

      // 软删：保留记录用于审计，鉴权时按 revokedAt 拒绝
      db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).run();
      writeAudit(db, {
        appId: row.appId,
        actorType: 'master',
        action: 'key.revoke',
        target: id,
        ip: req.ip,
        meta: { keyPrefix: row.keyPrefix },
      });
      return { revoked: true as const, id, keyPrefix: row.keyPrefix };
    },
  );
}
