import { Type } from '@sinclair/typebox';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@ssio/shared';
import { forumBoards, forumPosts, forumThreads } from '../db/schema.js';
import { newId } from '../db/client.js';
import { NullableInteger, NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const BoardSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  description: NullableString(),
  sortOrder: Type.Integer(),
  threadCount: Type.Integer(),
  createdAt: Type.Integer(),
});

const ThreadSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  boardId: Type.String(),
  title: Type.String(),
  authorId: Type.String(),
  contentMd: Type.String(),
  pinned: Type.Boolean(),
  locked: Type.Boolean(),
  replyCount: Type.Integer(),
  viewCount: Type.Integer(),
  lastReplyAt: NullableInteger(),
  createdAt: Type.Integer(),
});

const PostSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  threadId: Type.String(),
  authorId: Type.String(),
  contentMd: Type.String(),
  floor: Type.Integer(),
  createdAt: Type.Integer(),
});

/**
 * 论坛（P3）。
 *
 * 权限划分是这里最值得说的设计：
 * - **读**：APIKey（forum:read）或用户 JWT 都行 —— 业务服务端要能聚合展示，用户要能浏览
 * - **写（发帖/回复）：必须是用户 JWT**。APIKey 代表应用而非人，拿它发帖会分不清
 *   「用户说的」和「应用说的」， moderation 也会失去依据
 * - **管理（建版块 / 置顶 / 锁帖）：必须是 APIKey（forum:write）**，用户无权自己给自己置顶
 */
export async function registerForum(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db } = opts;

  function requireReader() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (req.headers['x-api-key']) {
        await app.requireApiKey({ scopes: ['forum:read'] })(req, reply);
        return;
      }
      await app.requireUser()(req, reply);
    };
  }

  /** 发帖/回复：只认用户身份。 */
  function requireAuthor() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await app.requireUser()(req, reply);
      if (!req.ctx.userId) throw new AppError('FORBIDDEN', '需要用户身份');
    };
  }

  function clampLimit(raw: unknown): number {
    const n = Number(raw ?? DEFAULT_LIMIT);
    return Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n))) : DEFAULT_LIMIT;
  }

  // ---- 版块 ----

  app.post(
    '/v1/forum/boards',
    {
      preHandler: [app.requireApiKey({ scopes: ['forum:write'] })],
      schema: {
        body: Type.Object({
          slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,30}$' }),
          name: Type.String({ minLength: 1, maxLength: 64 }),
          description: Type.Optional(Type.String({ maxLength: 500 })),
          sortOrder: Type.Optional(Type.Integer()),
        }),
        response: { 201: BoardSchema },
      },
    },
    (req, reply) => {
      const body = req.body as { slug: string; name: string; description?: string; sortOrder?: number };
      const appId = req.ctx.appId!;
      const exists = db
        .select()
        .from(forumBoards)
        .where(and(eq(forumBoards.appId, appId), eq(forumBoards.slug, body.slug)))
        .get();
      if (exists) throw new AppError('CONFLICT', `板块 slug 已被占用: ${body.slug}`);

      const row = {
        id: newId(),
        appId,
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        sortOrder: body.sortOrder ?? 0,
        threadCount: 0,
        createdAt: Date.now(),
      };
      db.insert(forumBoards).values(row).run();
      void reply.code(201);
      return row;
    },
  );

  app.get(
    '/v1/forum/boards',
    { preHandler: [requireReader()], schema: { response: { 200: Type.Array(BoardSchema) } } },
    (req) => {
      return db
        .select()
        .from(forumBoards)
        .where(eq(forumBoards.appId, req.ctx.appId!))
        .orderBy(desc(forumBoards.sortOrder), forumBoards.createdAt)
        .all();
    },
  );

  // ---- 帖子 ----

  app.post(
    '/v1/forum/boards/:slug/threads',
    {
      preHandler: [requireAuthor()],
      schema: {
        body: Type.Object({
          title: Type.String({ minLength: 1, maxLength: 200 }),
          contentMd: Type.String({ minLength: 1, maxLength: 20_000 }),
        }),
        response: { 201: ThreadSchema },
      },
    },
    (req, reply) => {
      const slug = (req.params as { slug: string }).slug;
      const body = req.body as { title: string; contentMd: string };
      const appId = req.ctx.appId!;
      const board = db
        .select()
        .from(forumBoards)
        .where(and(eq(forumBoards.appId, appId), eq(forumBoards.slug, slug)))
        .get();
      if (!board) throw new AppError('NOT_FOUND', `板块不存在: ${slug}`);

      const thread = {
        id: newId(),
        appId,
        boardId: board.id,
        title: body.title,
        authorId: req.ctx.userId!,
        contentMd: body.contentMd,
        pinned: false,
        locked: false,
        replyCount: 0,
        viewCount: 0,
        lastReplyAt: null as number | null,
        createdAt: Date.now(),
      };
      // 帖子与板块计数必须同生共死，否则列表页的 threadCount 会慢慢失真
      db.transaction((tx) => {
        tx.insert(forumThreads).values(thread).run();
        tx.update(forumBoards)
          .set({ threadCount: sql`${forumBoards.threadCount} + 1` })
          .where(eq(forumBoards.id, board.id))
          .run();
      });
      void reply.code(201);
      return thread;
    },
  );

  app.get(
    '/v1/forum/boards/:slug/threads',
    { preHandler: [requireReader()], schema: { response: { 200: Type.Array(ThreadSchema) } } },
    (req) => {
      const slug = (req.params as { slug: string }).slug;
      const { limit, offset } = req.query as { limit?: number; offset?: number };
      const board = db
        .select()
        .from(forumBoards)
        .where(and(eq(forumBoards.appId, req.ctx.appId!), eq(forumBoards.slug, slug)))
        .get();
      if (!board) throw new AppError('NOT_FOUND', `板块不存在: ${slug}`);

      // 置顶优先，其余按最后回复时间倒序（没回复过的按创建时间排最后）
      return db
        .select()
        .from(forumThreads)
        .where(eq(forumThreads.boardId, board.id))
        .orderBy(desc(forumThreads.pinned), desc(sql`coalesce(${forumThreads.lastReplyAt}, ${forumThreads.createdAt})`))
        .limit(clampLimit(limit))
        .offset(Number(offset ?? 0))
        .all();
    },
  );

  app.get(
    '/v1/forum/threads/:id',
    { preHandler: [requireReader()], schema: { response: { 200: ThreadSchema } } },
    (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(forumThreads).where(eq(forumThreads.id, id)).get();
      if (!row || row.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '帖子不存在');
      db.update(forumThreads)
        .set({ viewCount: sql`${forumThreads.viewCount} + 1` })
        .where(eq(forumThreads.id, id))
        .run();
      return { ...row, viewCount: row.viewCount + 1 };
    },
  );

  app.patch(
    '/v1/forum/threads/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['forum:write'] })],
      schema: {
        body: Type.Object({ pinned: Type.Optional(Type.Boolean()), locked: Type.Optional(Type.Boolean()) }),
        response: { 200: ThreadSchema },
      },
    },
    (req) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as { pinned?: boolean; locked?: boolean };
      const row = db.select().from(forumThreads).where(eq(forumThreads.id, id)).get();
      if (!row || row.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '帖子不存在');

      db.update(forumThreads)
        .set({
          pinned: body.pinned ?? row.pinned,
          locked: body.locked ?? row.locked,
        })
        .where(eq(forumThreads.id, id))
        .run();
      return { ...row, pinned: body.pinned ?? row.pinned, locked: body.locked ?? row.locked };
    },
  );

  // ---- 回复 ----

  app.post(
    '/v1/forum/threads/:id/posts',
    {
      preHandler: [requireAuthor()],
      schema: {
        body: Type.Object({ contentMd: Type.String({ minLength: 1, maxLength: 20_000 }) }),
        response: { 201: PostSchema },
      },
    },
    (req, reply) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as { contentMd: string };
      const thread = db.select().from(forumThreads).where(eq(forumThreads.id, id)).get();
      if (!thread || thread.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '帖子不存在');
      if (thread.locked) throw new AppError('FORBIDDEN', '帖子已锁定，禁止回复');

      const now = Date.now();
      const post = {
        id: newId(),
        appId: thread.appId,
        threadId: thread.id,
        authorId: req.ctx.userId!,
        contentMd: body.contentMd,
        // 楼层号由 replyCount 推导：同一事务内自增，天然连续
        floor: thread.replyCount + 1,
        createdAt: now,
      };
      db.transaction((tx) => {
        tx.insert(forumPosts).values(post).run();
        tx.update(forumThreads)
          .set({ replyCount: sql`${forumThreads.replyCount} + 1`, lastReplyAt: now })
          .where(eq(forumThreads.id, thread.id))
          .run();
      });
      void reply.code(201);
      return post;
    },
  );

  app.get(
    '/v1/forum/threads/:id/posts',
    { preHandler: [requireReader()], schema: { response: { 200: Type.Array(PostSchema) } } },
    (req) => {
      const id = (req.params as { id: string }).id;
      const { limit, offset } = req.query as { limit?: number; offset?: number };
      const thread = db.select().from(forumThreads).where(eq(forumThreads.id, id)).get();
      if (!thread || thread.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '帖子不存在');

      return db
        .select()
        .from(forumPosts)
        .where(eq(forumPosts.threadId, thread.id))
        .orderBy(forumPosts.floor)
        .limit(clampLimit(limit))
        .offset(Number(offset ?? 0))
        .all();
    },
  );
}
