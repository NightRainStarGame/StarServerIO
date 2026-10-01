import { Type } from '@sinclair/typebox';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, compare as compareSemver } from '@ssio/shared';
import { files, registryPackages, registryVersions } from '../db/schema.js';
import { newId } from '../db/client.js';
import { NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const CHANNELS = ['stable', 'beta', 'alpha'] as const;

const PackageSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  name: Type.String(),
  description: NullableString(),
  latestVersion: NullableString(),
  downloadCount: Type.Integer(),
  createdAt: Type.Integer(),
});

const VersionSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  packageId: Type.String(),
  version: Type.String(),
  channel: Type.String(),
  fileId: Type.String(),
  sizeBytes: Type.Integer(),
  sha256: Type.String(),
  meta: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  downloadCount: Type.Integer(),
  createdAt: Type.Integer(),
});

/**
 * 软件源（P3）：通用包分发。
 *
 * 与「发行（/v1/releases）」的区别要讲清楚，否则两个模块会互相侵蚀：
 * - releases 面向**应用更新**：有 platform/arch/灰度/minVersion，客户端拿它决定"要不要升"
 * - registry 面向**包管理**：只有 name + version + 元数据，消费方自己解释含义
 *   （npm 式依赖、插件包、资源包都行）。它不认识平台，也不做灰度
 *
 * 包体不单独存：复用 storage，fileId 指过去就行 —— 配额、秒传、签名下载全都白拿。
 */
export async function registerRegistry(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db, storage } = opts;

  function findPackage(appId: string, name: string) {
    return db
      .select()
      .from(registryPackages)
      .where(and(eq(registryPackages.appId, appId), eq(registryPackages.name, name)))
      .get();
  }

  app.post(
    '/v1/registry/packages',
    {
      preHandler: [app.requireApiKey({ scopes: ['source:write'] })],
      schema: {
        body: Type.Object({
          name: Type.String({ pattern: '^[a-z0-9][a-z0-9._-]{1,60}$' }),
          description: Type.Optional(Type.String({ maxLength: 500 })),
        }),
        response: { 201: PackageSchema },
      },
    },
    (req, reply) => {
      const body = req.body as { name: string; description?: string };
      const appId = req.ctx.appId!;
      if (findPackage(appId, body.name)) throw new AppError('CONFLICT', `包已存在: ${body.name}`);

      const row = {
        id: newId(),
        appId,
        name: body.name,
        description: body.description ?? null,
        latestVersion: null as string | null,
        downloadCount: 0,
        createdAt: Date.now(),
      };
      db.insert(registryPackages).values(row).run();
      void reply.code(201);
      return row;
    },
  );

  app.get(
    '/v1/registry/packages',
    { preHandler: [app.requireApiKey({ scopes: ['source:read'] })], schema: { response: { 200: Type.Array(PackageSchema) } } },
    (req) => db.select().from(registryPackages).where(eq(registryPackages.appId, req.ctx.appId!)).all(),
  );

  app.get(
    '/v1/registry/packages/:name',
    {
      preHandler: [app.requireApiKey({ scopes: ['source:read'] })],
      schema: { response: { 200: Type.Intersect([PackageSchema, Type.Object({ versions: Type.Array(VersionSchema) })]) } },
    },
    (req) => {
      const name = (req.params as { name: string }).name;
      const pkg = findPackage(req.ctx.appId!, name);
      if (!pkg) throw new AppError('NOT_FOUND', `包不存在: ${name}`);
      const versions = db
        .select()
        .from(registryVersions)
        .where(eq(registryVersions.packageId, pkg.id))
        .orderBy(desc(registryVersions.createdAt))
        .all();
      return { ...pkg, versions };
    },
  );

  app.post(
    '/v1/registry/packages/:name/versions',
    {
      preHandler: [app.requireApiKey({ scopes: ['source:write'] })],
      schema: {
        body: Type.Object({
          version: Type.String({ minLength: 1, maxLength: 64 }),
          channel: Type.Optional(Type.Union(CHANNELS.map((c) => Type.Literal(c)) as never)),
          fileId: Type.String({ minLength: 1 }),
          meta: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
        }),
        response: { 201: VersionSchema },
      },
    },
    (req, reply) => {
      const name = (req.params as { name: string }).name;
      const body = req.body as { version: string; channel?: string; fileId: string; meta?: Record<string, unknown> | null };
      const appId = req.ctx.appId!;
      const pkg = findPackage(appId, name);
      if (!pkg) throw new AppError('NOT_FOUND', `包不存在: ${name}`);

      // 包体必须是本应用自己的文件：否则一个应用的 Key 能把别人的对象挂进自己的源里
      const file = db.select().from(files).where(eq(files.id, body.fileId)).get();
      if (!file || file.appId !== appId || file.deletedAt !== null) {
        throw new AppError('NOT_FOUND', `文件不存在或不属于本应用: ${body.fileId}`);
      }

      const dup = db
        .select()
        .from(registryVersions)
        .where(and(eq(registryVersions.packageId, pkg.id), eq(registryVersions.version, body.version)))
        .get();
      // 覆盖发布会让已下载该版本的人拿到不同内容，这里直接拒绝
      if (dup) throw new AppError('CONFLICT', `版本已存在: ${body.version}（版本不可覆盖，请发新版本号）`);

      const row = {
        id: newId(),
        appId,
        packageId: pkg.id,
        version: body.version,
        channel: (body.channel ?? 'stable') as (typeof CHANNELS)[number],
        fileId: file.id,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        meta: body.meta ?? null,
        downloadCount: 0,
        createdAt: Date.now(),
      };

      db.transaction((tx) => {
        tx.insert(registryVersions).values(row).run();
        // latest 只在 semver 更大时前进：回滚发布（发个旧版本）不该把 latest 拉回去
        if (!pkg.latestVersion || compareSemver(row.version, pkg.latestVersion) > 0) {
          tx.update(registryPackages)
            .set({ latestVersion: row.version })
            .where(eq(registryPackages.id, pkg.id))
            .run();
        }
      });
      void reply.code(201);
      return row;
    },
  );

  app.get(
    '/v1/registry/packages/:name/latest',
    {
      preHandler: [app.requireApiKey({ scopes: ['source:read'] })],
      schema: { response: { 200: VersionSchema } },
    },
    (req) => {
      const name = (req.params as { name: string }).name;
      const { channel } = req.query as { channel?: (typeof CHANNELS)[number] };
      const pkg = findPackage(req.ctx.appId!, name);
      if (!pkg) throw new AppError('NOT_FOUND', `包不存在: ${name}`);

      const conds = [eq(registryVersions.packageId, pkg.id)];
      if (channel) conds.push(eq(registryVersions.channel, channel));
      const rows = db
        .select()
        .from(registryVersions)
        .where(and(...conds))
        .all();
      if (rows.length === 0) throw new AppError('NOT_FOUND', '还没有版本');

      // latest 按 semver 取最大，不按发布时间 —— 后发的可能是补丁旧版本
      const best = rows.reduce((a, b) => (compareSemver(b.version, a.version) > 0 ? b : a));
      return best;
    },
  );

  app.post(
    '/v1/registry/packages/:name/:version/download',
    {
      preHandler: [app.requireApiKey({ scopes: ['source:read'] })],
      schema: {
        body: Type.Optional(Type.Object({ ttl: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600 })) })),
        response: {
          200: Type.Object({
            url: Type.String(),
            expiresAt: Type.Integer(),
            sizeBytes: Type.Integer(),
            sha256: Type.String(),
          }),
        },
      },
    },
    async (req) => {
      const { name, version } = req.params as { name: string; version: string };
      const pkg = findPackage(req.ctx.appId!, name);
      if (!pkg) throw new AppError('NOT_FOUND', `包不存在: ${name}`);
      const row = db
        .select()
        .from(registryVersions)
        .where(and(eq(registryVersions.packageId, pkg.id), eq(registryVersions.version, version)))
        .get();
      if (!row) throw new AppError('NOT_FOUND', `版本不存在: ${version}`);

      db.transaction((tx) => {
        tx.update(registryVersions)
          .set({ downloadCount: sql`${registryVersions.downloadCount} + 1` })
          .where(eq(registryVersions.id, row.id))
          .run();
        tx.update(registryPackages)
          .set({ downloadCount: sql`${registryPackages.downloadCount} + 1` })
          .where(eq(registryPackages.id, pkg.id))
          .run();
      });

      const ttl = (req.body as { ttl?: number } | undefined)?.ttl ?? 300;
      // signUrl 认的是 **storageKey**，不是 fileId：传 fileId 也能签出 URL，
      // 但 raw 端点按 storageKey 查 files 会查不到 → 404（踩过一次）
      const f = db.select().from(files).where(eq(files.id, row.fileId)).get();
      if (!f || f.deletedAt !== null) throw new AppError('NOT_FOUND', '包体文件已不可用');
      const url = await storage.driver.signUrl(f.storageKey, ttl);
      return { url, expiresAt: Date.now() + ttl * 1000, sizeBytes: row.sizeBytes, sha256: row.sha256 };
    },
  );
}
