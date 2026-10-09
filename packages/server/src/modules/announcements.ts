import { Type } from '@sinclair/typebox';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@ssio/shared';
import { announcements } from '../db/schema.js';
import { newId } from '../db/client.js';
import { NullableInteger, NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const LEVELS = ['info', 'warning', 'urgent'] as const;

const AnnouncementSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  title: Type.String(),
  contentMd: Type.String(),
  level: Type.String(),
  pinned: Type.Boolean(),
  startAt: Type.Integer(),
  endAt: NullableInteger(),
  createdBy: NullableString(),
  createdAt: Type.Integer(),
});

const CreateBody = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  contentMd: Type.String({ minLength: 1, maxLength: 20_000 }),
  level: Type.Optional(Type.Union(LEVELS.map((l) => Type.Literal(l)) as never)),
  pinned: Type.Optional(Type.Boolean()),
  startAt: Type.Optional(Type.Integer()),
  endAt: Type.Optional(NullableInteger()),
});

const PatchBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  contentMd: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
  level: Type.Optional(Type.Union(LEVELS.map((l) => Type.Literal(l)) as never)),
  pinned: Type.Optional(Type.Boolean()),
  startAt: Type.Optional(Type.Integer()),
  endAt: Type.Optional(NullableInteger()),
});

function toResponse(r: typeof announcements.$inferSelect) {
  return {
    id: r.id,
    appId: r.appId,
    title: r.title,
    contentMd: r.contentMd,
    level: r.level,
    pinned: r.pinned,
    startAt: r.startAt,
    endAt: r.endAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

/**
 * 公告。
 *
 * 只负责「存、排序、按时段生效」，不解释业务含义 ——
 * 消费方可以拿它做首页公告、维护通知或活动置顶，那是消费方的事。
 */
export async function registerAnnouncements(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db } = opts;

  /** 读接口对业务服务端和终端用户都开放；写接口只认 APIKey。 */
  function requireReader() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (req.headers['x-api-key']) {
        await app.requireApiKey({ scopes: ['announcements:read'] })(req, reply);
        return;
      }
      await app.requireUser()(req, reply);
    };
  }

  app.post(
    '/v1/announcements',
    {
      preHandler: [app.requireApiKey({ scopes: ['announcements:write'] })],
      schema: { body: CreateBody, response: { 201: AnnouncementSchema } },
    },
    (req, reply) => {
      const body = req.body as {
        title: string;
        contentMd: string;
        level?: (typeof LEVELS)[number];
        pinned?: boolean;
        startAt?: number;
        endAt?: number | null;
      };
      if (body.endAt != null && body.startAt != null && body.endAt <= body.startAt) {
        throw new AppError('VALIDATION', 'endAt 必须晚于 startAt');
      }
      const now = Date.now();
      const row = {
        id: newId(),
        appId: req.ctx.appId!,
        title: body.title,
        contentMd: body.contentMd,
        level: body.level ?? 'info',
        pinned: body.pinned ?? false,
        startAt: body.startAt ?? now,
        endAt: body.endAt ?? null,
        createdBy: req.ctx.userId ?? null,
        createdAt: now,
      };
      db.insert(announcements).values(row).run();
      void reply.code(201);
      return toResponse(row);
    },
  );

  app.get(
    '/v1/announcements',
    {
      preHandler: [app.requireApiKey({ scopes: ['announcements:read'] })],
      schema: { response: { 200: Type.Array(AnnouncementSchema) } },
    },
    (req) => {
      const rows = db
        .select()
        .from(announcements)
        .where(eq(announcements.appId, req.ctx.appId!))
        .orderBy(desc(announcements.startAt))
        .all();
      return rows.map(toResponse);
    },
  );

  app.get(
    '/v1/announcements/active',
    { preHandler: [requireReader()], schema: { response: { 200: Type.Array(AnnouncementSchema) } } },
    (req) => {
      const now = Date.now();
      const rows = db
        .select()
        .from(announcements)
        .where(
          and(
            eq(announcements.appId, req.ctx.appId!),
            // 已开始（startAt <= now）
            lte(announcements.startAt, now),
            // 未结束：endAt 为空表示长期有效
            sql`(${announcements.endAt} IS NULL OR ${announcements.endAt} > ${now})`,
          ),
        )
        // 置顶优先，同为置顶则新的在前
        .orderBy(desc(announcements.pinned), desc(announcements.startAt))
        .all();
      return rows.map(toResponse);
    },
  );

  app.patch(
    '/v1/announcements/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['announcements:write'] })],
      schema: { body: PatchBody, response: { 200: AnnouncementSchema } },
    },
    (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(announcements).where(eq(announcements.id, id)).get();
      if (!row || row.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '公告不存在');

      const body = req.body as Partial<{
        title: string;
        contentMd: string;
        level: (typeof LEVELS)[number];
        pinned: boolean;
        startAt: number;
        endAt: number | null;
      }>;
      const patch: Partial<typeof announcements.$inferInsert> = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.contentMd !== undefined) patch.contentMd = body.contentMd;
      if (body.level !== undefined) patch.level = body.level;
      if (body.pinned !== undefined) patch.pinned = body.pinned;
      if (body.startAt !== undefined) patch.startAt = body.startAt;
      if (body.endAt !== undefined) patch.endAt = body.endAt;

      const nextStart = patch.startAt ?? row.startAt;
      const nextEnd = patch.endAt === undefined ? row.endAt : patch.endAt;
      if (nextEnd != null && nextEnd <= nextStart) throw new AppError('VALIDATION', 'endAt 必须晚于 startAt');

      if (Object.keys(patch).length > 0) db.update(announcements).set(patch).where(eq(announcements.id, id)).run();
      return toResponse({ ...row, ...patch });
    },
  );

  app.delete(
    '/v1/announcements/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['announcements:delete'] })],
      schema: { response: { 200: Type.Object({ deleted: Type.Literal(true), id: Type.String() }) } },
    },
    (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(announcements).where(eq(announcements.id, id)).get();
      if (!row || row.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '公告不存在');
      db.delete(announcements).where(eq(announcements.id, id)).run();
      return { deleted: true as const, id };
    },
  );
}
