import { Type } from '@sinclair/typebox';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, isValid as isValidSemver } from '@ssio/shared';
import { files, releases } from '../db/schema.js';
import { newId } from '../db/client.js';
import { pickLatest, type ReleaseRow } from '../release/selector.js';
import { NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const CHANNELS = ['stable', 'beta', 'alpha'] as const;
const PLATFORMS = ['win', 'linux', 'android', 'any'] as const;
const ARCHS = ['x64', 'arm64', 'any'] as const;

const DEFAULT_TTL_SEC = 300;

const ReleaseSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  channel: Type.String(),
  platform: Type.String(),
  arch: Type.String(),
  version: Type.String(),
  fileId: Type.String(),
  sizeBytes: Type.Integer(),
  sha256: Type.String(),
  notesMd: NullableString(),
  mandatory: Type.Boolean(),
  minVersion: NullableString(),
  rolloutPercent: Type.Integer(),
  published: Type.Boolean(),
  downloadCount: Type.Integer(),
  createdAt: Type.Integer(),
});

const CreateReleaseBody = Type.Object({
  channel: Type.Union(CHANNELS.map((c) => Type.Literal(c)) as never),
  platform: Type.Union(PLATFORMS.map((p) => Type.Literal(p)) as never),
  arch: Type.Union(ARCHS.map((a) => Type.Literal(a)) as never),
  version: Type.String({ minLength: 1, maxLength: 64 }),
  fileId: Type.String(),
  notesMd: Type.Optional(NullableString()),
  mandatory: Type.Optional(Type.Boolean()),
  minVersion: Type.Optional(NullableString()),
  rolloutPercent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  published: Type.Optional(Type.Boolean()),
});

const PatchReleaseBody = Type.Object({
  mandatory: Type.Optional(Type.Boolean()),
  rolloutPercent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  published: Type.Optional(Type.Boolean()),
  notesMd: Type.Optional(NullableString()),
});

function toRow(r: typeof releases.$inferSelect): ReleaseRow {
  return {
    id: r.id,
    version: r.version,
    channel: r.channel,
    platform: r.platform,
    arch: r.arch,
    fileId: r.fileId,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    notesMd: r.notesMd,
    mandatory: r.mandatory,
    minVersion: r.minVersion,
    rolloutPercent: r.rolloutPercent,
    published: r.published,
    downloadCount: r.downloadCount,
    createdAt: r.createdAt,
    deletedAt: r.deletedAt,
  };
}

function toResponse(r: typeof releases.$inferSelect) {
  return {
    id: r.id,
    appId: r.appId,
    channel: r.channel,
    platform: r.platform,
    arch: r.arch,
    version: r.version,
    fileId: r.fileId,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    notesMd: r.notesMd,
    mandatory: r.mandatory,
    minVersion: r.minVersion,
    rolloutPercent: r.rolloutPercent,
    published: r.published,
    downloadCount: r.downloadCount,
    createdAt: r.createdAt,
  };
}

/**
 * Release 发行平台。
 *
 * `latest` 的判定全在 `release/selector.ts`（纯函数），这里只负责取数与拼装响应；
 * 版本号一律走 semver 比较，避免 `1.10.0 < 1.9.0` 这种字符串比较事故。
 */
export async function registerReleases(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db, storage } = opts;

  app.post(
    '/v1/releases',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:write'] })],
      schema: { body: CreateReleaseBody, response: { 201: ReleaseSchema } },
    },
    async (req, reply) => {
      const body = req.body as {
        channel: (typeof CHANNELS)[number];
        platform: (typeof PLATFORMS)[number];
        arch: (typeof ARCHS)[number];
        version: string;
        fileId: string;
        notesMd?: string | null;
        mandatory?: boolean;
        minVersion?: string | null;
        rolloutPercent?: number;
        published?: boolean;
      };
      const appId = req.ctx.appId!;

      if (!isValidSemver(body.version)) throw new AppError('VALIDATION', 'version 不是合法语义化版本号');
      if (body.minVersion && !isValidSemver(body.minVersion)) {
        throw new AppError('VALIDATION', 'minVersion 不是合法语义化版本号');
      }

      // 文件必须存在且属于本应用：跨应用引用文件会变成越权读取
      const f = db.select().from(files).where(eq(files.id, body.fileId)).get();
      if (!f || f.appId !== appId || f.deletedAt !== null) throw new AppError('NOT_FOUND', '文件不存在');

      const row = {
        id: newId(),
        appId,
        channel: body.channel,
        platform: body.platform,
        arch: body.arch,
        version: body.version,
        fileId: f.id,
        sizeBytes: f.sizeBytes,
        // sha256 以文件记录为准：它才是实际落盘内容的哈希
        sha256: f.sha256,
        notesMd: body.notesMd ?? null,
        mandatory: body.mandatory ?? false,
        minVersion: body.minVersion ?? null,
        rolloutPercent: body.rolloutPercent ?? 100,
        published: body.published ?? false,
        downloadCount: 0,
        createdAt: Date.now(),
        deletedAt: null,
      };

      try {
        db.insert(releases).values(row).run();
      } catch (e) {
        // 唯一约束 (appId,channel,platform,arch,version) 撞车
        if (e instanceof Error && e.message.includes('UNIQUE')) {
          throw new AppError('CONFLICT', '该渠道下已存在相同版本');
        }
        throw e;
      }

      void reply.code(201);
      return toResponse(row);
    },
  );

  app.get(
    '/v1/releases',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:read'] })],
      schema: {
        querystring: Type.Object({
          channel: Type.Optional(Type.String()),
          platform: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        response: { 200: Type.Array(ReleaseSchema) },
      },
    },
    async (req) => {
      // 类型声明用列的字面量联合：否则 eq() 会因为 string 无法赋给联合类型而报错
      const { channel, platform, limit = 50, offset = 0 } = req.query as {
        channel?: (typeof CHANNELS)[number];
        platform?: (typeof PLATFORMS)[number];
        limit?: number;
        offset?: number;
      };
      // 显式标注：否则 TS 会把数组推断成首元素的列类型，后续 push 其它列会报 never
      const conds: SQL[] = [eq(releases.appId, req.ctx.appId!), isNull(releases.deletedAt)];
      if (channel) conds.push(eq(releases.channel, channel));
      if (platform) conds.push(eq(releases.platform, platform));
      const rows = db
        .select()
        .from(releases)
        .where(and(...conds))
        .orderBy(desc(releases.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
      return rows.map(toResponse);
    },
  );

  app.get(
    '/v1/releases/latest',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:read'] })],
      schema: {
        querystring: Type.Object({
          platform: Type.String(),
          channel: Type.Optional(Type.String()),
          current: Type.Optional(Type.String()),
          arch: Type.Optional(Type.String()),
          clientId: Type.Optional(Type.String()),
        }),
      },
    },
    async (req) => {
      const { platform, channel = 'stable', current, arch, clientId } = req.query as {
        platform: string;
        channel?: string;
        current?: string;
        arch?: string;
        clientId?: string;
      };
      if (current && !isValidSemver(current)) throw new AppError('VALIDATION', 'current 不是合法语义化版本号');

      const rows = db
        .select()
        .from(releases)
        .where(and(eq(releases.appId, req.ctx.appId!), isNull(releases.deletedAt)))
        .all()
        .map(toRow);

      const result = pickLatest(rows, { platform, channel, arch, current, clientId });
      if (!result.hasUpdate) return { hasUpdate: false as const };

      const url = await storage.driver.signUrl(
        db.select().from(files).where(eq(files.id, result.release.fileId)).get()!.storageKey,
        DEFAULT_TTL_SEC,
      );
      return {
        hasUpdate: true as const,
        // 给 updater 用：下载计数/回查版本详情都靠它
        releaseId: result.release.id,
        version: result.release.version,
        notes: result.release.notesMd,
        size: result.release.sizeBytes,
        sha256: result.release.sha256,
        url: `${req.protocol}://${req.host}${url}`,
        mandatory: result.mandatory,
        publishedAt: result.release.createdAt,
      };
    },
  );

  app.get(
    '/v1/releases/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:read'] })],
      schema: { response: { 200: ReleaseSchema } },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(releases).where(eq(releases.id, id)).get();
      if (!row || row.appId !== req.ctx.appId! || row.deletedAt !== null) {
        throw new AppError('NOT_FOUND', '版本不存在');
      }
      return toResponse(row);
    },
  );

  app.patch(
    '/v1/releases/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:write'] })],
      schema: { body: PatchReleaseBody, response: { 200: ReleaseSchema } },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as { mandatory?: boolean; rolloutPercent?: number; published?: boolean; notesMd?: string | null };
      const row = db.select().from(releases).where(eq(releases.id, id)).get();
      if (!row || row.appId !== req.ctx.appId! || row.deletedAt !== null) {
        throw new AppError('NOT_FOUND', '版本不存在');
      }
      const patch: Partial<typeof releases.$inferInsert> = {};
      if (body.mandatory !== undefined) patch.mandatory = body.mandatory;
      if (body.rolloutPercent !== undefined) patch.rolloutPercent = body.rolloutPercent;
      if (body.published !== undefined) patch.published = body.published;
      if (body.notesMd !== undefined) patch.notesMd = body.notesMd;
      if (Object.keys(patch).length > 0) db.update(releases).set(patch).where(eq(releases.id, id)).run();
      return toResponse({ ...row, ...patch });
    },
  );

  app.delete(
    '/v1/releases/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:write'] })],
      schema: { response: { 200: Type.Object({ deleted: Type.Literal(true), id: Type.String() }) } },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(releases).where(eq(releases.id, id)).get();
      if (!row || row.appId !== req.ctx.appId!) throw new AppError('NOT_FOUND', '版本不存在');
      // 软删：下架不该抹掉历史，客户端只会因此再也查不到它
      db.update(releases).set({ deletedAt: Date.now() }).where(eq(releases.id, id)).run();
      return { deleted: true as const, id };
    },
  );

  app.post(
    '/v1/releases/:id/download',
    {
      preHandler: [app.requireApiKey({ scopes: ['release:read'] })],
      schema: { response: { 200: Type.Object({ url: Type.String(), expiresAt: Type.Integer(), ttl: Type.Integer() }) } },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const row = db.select().from(releases).where(eq(releases.id, id)).get();
      if (!row || row.appId !== req.ctx.appId! || row.deletedAt !== null) {
        throw new AppError('NOT_FOUND', '版本不存在');
      }
      const f = db.select().from(files).where(eq(files.id, row.fileId)).get();
      if (!f) throw new AppError('NOT_FOUND', '版本关联的文件不存在');

      const url = await storage.driver.signUrl(f.storageKey, DEFAULT_TTL_SEC);
      // 下载计数：用 SQL 自增而不是 read-modify-write，避免并发下丢计数
      db.update(releases).set({ downloadCount: sql`${releases.downloadCount} + 1` }).where(eq(releases.id, id)).run();
      return { url: `${req.protocol}://${req.host}${url}`, expiresAt: Date.now() + DEFAULT_TTL_SEC * 1000, ttl: DEFAULT_TTL_SEC };
    },
  );
}
