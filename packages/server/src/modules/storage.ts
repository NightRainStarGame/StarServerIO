import { Type } from '@sinclair/typebox';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@ssio/shared';
import { files, releases } from '../db/schema.js';
import { MAX_CHUNK_SIZE } from '../storage/driver.js';
import { LocalDriver } from '../storage/local.js';
import { NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

/** 签名 URL 默认 5 分钟，最长 1 小时。 */
const DEFAULT_TTL_SEC = 300;
const MAX_TTL_SEC = 3600;

const FileSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  filename: Type.String(),
  mime: NullableString(),
  sizeBytes: Type.Integer(),
  sha256: Type.String(),
  createdAt: Type.Integer(),
});

const InitUploadBody = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: 255 }),
  totalSize: Type.Integer({ minimum: 1 }),
  mime: Type.Optional(NullableString()),
  chunkSize: Type.Optional(Type.Integer()),
});

const CompleteBody = Type.Object({
  sha256: Type.String({ pattern: '^[a-fA-F0-9]{64}$' }),
});

/**
 * 文件存储：分片上传 + 签名下载。
 *
 * 鉴权全部走 APIKey（scope: storage:read / storage:write），
 * 唯一的例外是 `/raw/*` —— 它只认 URL 签名，不认 APIKey。
 * 原因是签名 URL 会直接交给浏览器/更新器，把 APIKey 塞进去等于泄露。
 */
export async function registerStorage(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db, storage } = opts;

  // 分片以裸二进制流上传，Fastify 默认只解析 JSON，必须显式注册 buffer 解析器
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post(
    '/v1/storage/uploads',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:write'] })],
      schema: {
        body: InitUploadBody,
        response: {
          201: Type.Object({
            uploadId: Type.String(),
            chunkSize: Type.Integer(),
            totalChunks: Type.Integer(),
            expiresAt: Type.Integer(),
          }),
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { filename: string; totalSize: number; mime?: string | null; chunkSize?: number };
      const res = storage.initUpload({
        appId: req.ctx.appId!,
        uploaderId: req.ctx.userId ?? null,
        filename: body.filename,
        totalSize: body.totalSize,
        mime: body.mime,
        chunkSize: body.chunkSize,
      });
      void reply.code(201);
      return res;
    },
  );

  app.put(
    '/v1/storage/uploads/:id/chunks/:index',
    {
      // 分片最大 16 MiB，Fastify 默认 bodyLimit 只有 1 MiB，必须按路由放宽
      bodyLimit: MAX_CHUNK_SIZE + 1024 * 1024,
      preHandler: [app.requireApiKey({ scopes: ['storage:write'] })],
    },
    async (req) => {
      const { id, index } = req.params as { id: string; index: string };
      const idx = Number(index);
      const chunk = req.body;
      if (!Buffer.isBuffer(chunk)) throw new AppError('BAD_REQUEST', '分片必须以 application/octet-stream 裸流上传');
      return storage.putChunk(id, req.ctx.appId!, idx, chunk);
    },
  );

  app.post(
    '/v1/storage/uploads/:id/complete',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:write'] })],
      schema: {
        body: CompleteBody,
        response: {
          200: Type.Object({
            fileId: Type.String(),
            sizeBytes: Type.Integer(),
            sha256: Type.String(),
            dedup: Type.Boolean(),
          }),
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { sha256 } = req.body as { sha256: string };
      return storage.complete(id, req.ctx.appId!, sha256);
    },
  );

  app.delete(
    '/v1/storage/uploads/:id',
    { preHandler: [app.requireApiKey({ scopes: ['storage:write'] })] },
    async (req) => {
      const { id } = req.params as { id: string };
      await storage.abort(id, req.ctx.appId!);
      return { aborted: true as const, uploadId: id };
    },
  );

  app.get(
    '/v1/storage/files/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:read'] })],
      schema: { response: { 200: FileSchema } },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const f = storage.getFile(id, req.ctx.appId!);
      return {
        id: f.id,
        appId: f.appId,
        filename: f.filename,
        mime: f.mime,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        createdAt: f.createdAt,
      };
    },
  );

  app.get(
    '/v1/storage/files/:id/download',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:read'] })],
      schema: {
        querystring: Type.Object({ ttl: Type.Optional(Type.Integer({ minimum: 1 })) }),
        response: { 200: Type.Object({ url: Type.String(), expiresAt: Type.Integer(), ttl: Type.Integer() }) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { ttl: rawTtl } = req.query as { ttl?: number };
      const f = storage.getFile(id, req.ctx.appId!);

      const ttl = Math.min(rawTtl ?? DEFAULT_TTL_SEC, MAX_TTL_SEC);
      const signed = await storage.driver.signUrl(f.storageKey, ttl);
      // 返回绝对地址：客户端（更新器/浏览器）不必自己拼 host
      const abs = `${req.protocol}://${req.host}${signed}`;
      return { url: abs, expiresAt: Date.now() + ttl * 1000, ttl };
    },
  );

  app.delete(
    '/v1/storage/files/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:write'] })],
      schema: {
        querystring: Type.Object({ force: Type.Optional(Type.Boolean()) }),
        response: { 200: Type.Object({ deleted: Type.Literal(true), id: Type.String() }) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { force } = req.query as { force?: boolean };
      const f = storage.getFile(id, req.ctx.appId!);

      // 被发行版本引用的文件不能随便删：删了会让客户端拿到 404 的更新包
      const ref = db
        .select({ id: releases.id })
        .from(releases)
        .where(and(eq(releases.fileId, id), isNull(releases.deletedAt)))
        .get();
      if (ref && force !== true) {
        throw new AppError('CONFLICT', '该文件正被发行版本引用，如需强制删除请带 ?force=true', { releaseId: ref.id });
      }

      // 软删：记录保留用于审计，配额不再计入（usedBytes 只统计 deletedAt 为空的）
      db.update(files).set({ deletedAt: Date.now() }).where(eq(files.id, id)).run();
      return { deleted: true as const, id: f.id };
    },
  );

  app.get(
    '/v1/storage/quota',
    {
      preHandler: [app.requireApiKey({ scopes: ['storage:read'] })],
      schema: { response: { 200: Type.Object({ usedBytes: Type.Integer(), quotaBytes: Type.Integer() }) } },
    },
    async (req) => storage.quota(req.ctx.appId!),
  );

  // 签名下载端点：只认 URL 签名，不认 APIKey（签名 URL 会给到浏览器/更新器）
  // 注意 `*` 是 find-my-way 的「匹配剩余全部」（含斜杠），而 `**` 会被判为非法
  // （Wildcard must be the last character）。storageKey 是多层的，靠这条规则兜住。
  app.get('/v1/storage/raw/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    const driver = storage.driver;

    if (!(driver instanceof LocalDriver)) throw new AppError('INTERNAL', '当前存储驱动不支持签名下载');
    if (!exp || !sig || !driver.verify(key, Number(exp), sig)) {
      throw new AppError('UNAUTHORIZED', '下载链接无效或已过期');
    }

    const row = db.select().from(files).where(eq(files.storageKey, key)).get();
    if (!row || row.deletedAt !== null) throw new AppError('NOT_FOUND', '文件不存在');

    const rangeHeader = req.headers.range;
    const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;

    reply.header('Content-Type', row.mime ?? 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(row.filename)}"`);
    reply.header('Accept-Ranges', 'bytes');

    if (range) {
      const size = row.sizeBytes;
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) throw new AppError('BAD_REQUEST', '非法的 Range');
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(await driver.getRange(key, start, end));
    }

    reply.header('Content-Length', row.sizeBytes);
    return reply.send(await driver.get(key));
  });
}
