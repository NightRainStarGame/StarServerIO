import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, type AppRecord } from '@ssio/shared';
import { apiKeys, apps, refreshTokens, users } from '../db/schema.js';
import { newId } from '../db/client.js';
import { writeAudit } from '../lib/audit.js';
import { NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const AppSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  description: NullableString(),
  ownerId: NullableString(),
  createdAt: Type.Number(),
});

const CreateAppBody = Type.Object({
  slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,30}$', minLength: 3, maxLength: 32 }),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  ownerId: Type.Optional(NullableString()),
});

const UpdateAppBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  description: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 500 })])),
  ownerId: Type.Optional(NullableString()),
});

function toRecord(row: typeof apps.$inferSelect): AppRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
  };
}

/** 应用（租户）CRUD —— 全部走 Master Key，普通 APIKey 无权创建租户。 */
export async function registerApps(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db } = opts;

  app.post(
    '/v1/apps',
    { preHandler: [app.requireMaster()], schema: { body: CreateAppBody, response: { 201: AppSchema } } },
    async (req, reply) => {
      const body = req.body as {
        slug: string;
        name: string;
        description?: string;
        ownerId?: string | null;
      };

      const exists = db.select().from(apps).where(eq(apps.slug, body.slug)).get();
      if (exists) throw new AppError('CONFLICT', `slug 已被占用: ${body.slug}`);

      const row = {
        id: newId(),
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        ownerId: body.ownerId ?? null,
        createdAt: Date.now(),
      };
      db.insert(apps).values(row).run();

      writeAudit(db, {
        appId: row.id,
        actorType: 'master',
        action: 'app.create',
        target: row.slug,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });

      void reply.code(201);
      return toRecord(row);
    },
  );

  app.get(
    '/v1/apps',
    { preHandler: [app.requireMaster()], schema: { response: { 200: Type.Array(AppSchema) } } },
    async () => db.select().from(apps).all().map(toRecord),
  );

  app.get(
    '/v1/apps/:id',
    { preHandler: [app.requireMaster()], schema: { response: { 200: AppSchema } } },
    async (req) => {
      const row = db.select().from(apps).where(eq(apps.id, (req.params as { id: string }).id)).get();
      if (!row) throw new AppError('NOT_FOUND', '应用不存在');
      return toRecord(row);
    },
  );

  app.patch(
    '/v1/apps/:id',
    { preHandler: [app.requireMaster()], schema: { body: UpdateAppBody, response: { 200: AppSchema } } },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(apps).where(eq(apps.id, id)).get();
      if (!row) throw new AppError('NOT_FOUND', '应用不存在');

      const body = req.body as { name?: string; description?: string | null; ownerId?: string | null };
      const patch: Partial<typeof apps.$inferInsert> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.ownerId !== undefined) patch.ownerId = body.ownerId;

      if (Object.keys(patch).length > 0) db.update(apps).set(patch).where(eq(apps.id, id)).run();

      writeAudit(db, { appId: id, actorType: 'master', action: 'app.update', target: row.slug, ip: req.ip });
      return toRecord({ ...row, ...patch });
    },
  );

  app.delete(
    '/v1/apps/:id',
    {
      preHandler: [app.requireMaster()],
      schema: { response: { 200: Type.Object({ deleted: Type.Literal(true), id: Type.String() }) } },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(apps).where(eq(apps.id, id)).get();
      if (!row) throw new AppError('NOT_FOUND', '应用不存在');

      // 级联清理：schema 没有声明外键，必须手工删，否则会留下仍能登录的孤儿凭据
      db.transaction((tx) => {
        const userIds = tx.select({ id: users.id }).from(users).where(eq(users.appId, id)).all();
        for (const u of userIds) {
          tx.delete(refreshTokens).where(eq(refreshTokens.userId, u.id)).run();
        }
        tx.delete(users).where(eq(users.appId, id)).run();
        tx.delete(apiKeys).where(eq(apiKeys.appId, id)).run();
        tx.delete(apps).where(eq(apps.id, id)).run();
      });
      writeAudit(db, { appId: id, actorType: 'master', action: 'app.delete', target: row.slug, ip: req.ip });
      return { deleted: true as const, id };
    },
  );
}
