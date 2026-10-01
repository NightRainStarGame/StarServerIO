import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '@ssio/shared';
import { newId, type Db } from '../db/client.js';
import { apps, files, uploadSessions } from '../db/schema.js';
import {
  buildStorageKey,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  UPLOAD_SESSION_TTL_MS,
  type StorageDriver,
} from './driver.js';

export interface InitUploadInput {
  appId: string;
  uploaderId?: string | null;
  filename: string;
  totalSize: number;
  mime?: string | null;
  chunkSize?: number;
}

export interface InitUploadResult {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  expiresAt: number;
}

export interface CompleteResult {
  fileId: string;
  sizeBytes: number;
  sha256: string;
  /** 命中同应用已存在的文件（秒传）：没有真正写入新副本。 */
  dedup: boolean;
}

/**
 * 分片上传服务。
 *
 * 关键取舍：
 * - 分片先落临时目录（DATA_DIR/tmp/uploads/<sessionId>/<index>.part），complete 时才合并；
 * - 合并是**流式**的：逐片读 + 边算 sha256 边写入驱动，峰值内存只取决于分片大小；
 * - sha256 以服务端算出的为准，客户端声明值只用于比对。
 */
export class StorageService {
  private readonly db: Db;
  /** 暴露给路由层：签名 URL 与 raw 下载需要直接读驱动。 */
  readonly driver: StorageDriver;
  private readonly tmpRoot: string;

  constructor(db: Db, driver: StorageDriver, dataDir: string) {
    this.db = db;
    this.driver = driver;
    this.tmpRoot = resolve(dataDir, 'tmp', 'uploads');
  }

  private sessionDir(uploadId: string): string {
    return join(this.tmpRoot, uploadId);
  }

  private partPath(uploadId: string, index: number): string {
    return join(this.sessionDir(uploadId), `${index}.part`);
  }

  /** 应用已用字节数（只统计未删除的文件）。 */
  usedBytes(appId: string): number {
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${files.sizeBytes}), 0)` })
      .from(files)
      .where(and(eq(files.appId, appId), isNull(files.deletedAt)))
      .get();
    return Number(row?.total ?? 0);
  }

  private quotaBytes(appId: string): number {
    const row = this.db.select({ quotaBytes: apps.quotaBytes }).from(apps).where(eq(apps.id, appId)).get();
    return row?.quotaBytes ?? 0;
  }

  quota(appId: string): { usedBytes: number; quotaBytes: number } {
    return { usedBytes: this.usedBytes(appId), quotaBytes: this.quotaBytes(appId) };
  }

  initUpload(input: InitUploadInput): InitUploadResult {
    if (!Number.isInteger(input.totalSize) || input.totalSize <= 0) {
      throw new AppError('BAD_REQUEST', 'totalSize 必须为正整数');
    }

    const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      throw new AppError('BAD_REQUEST', `chunkSize 必须在 ${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE} 之间`);
    }

    // 配额在初始化时就按声明的完整大小预扣：否则传到 90% 才发现超配额，体验更差
    const { usedBytes, quotaBytes } = this.quota(input.appId);
    if (quotaBytes > 0 && usedBytes + input.totalSize > quotaBytes) {
      throw new AppError('QUOTA_EXCEEDED', '存储配额不足', { usedBytes, quotaBytes, requestedBytes: input.totalSize });
    }

    const totalChunks = Math.ceil(input.totalSize / chunkSize);
    const id = newId();
    const now = Date.now();
    this.db
      .insert(uploadSessions)
      .values({
        id,
        appId: input.appId,
        uploaderId: input.uploaderId ?? null,
        filename: input.filename,
        mime: input.mime ?? null,
        totalSize: input.totalSize,
        chunkSize,
        totalChunks,
        uploadedChunks: [],
        receivedBytes: 0,
        fileId: null,
        status: 'pending',
        expiresAt: now + UPLOAD_SESSION_TTL_MS,
        createdAt: now,
      })
      .run();

    return { uploadId: id, chunkSize, totalChunks, expiresAt: now + UPLOAD_SESSION_TTL_MS };
  }

  private loadSession(uploadId: string) {
    const row = this.db.select().from(uploadSessions).where(eq(uploadSessions.id, uploadId)).get();
    if (!row) throw new AppError('NOT_FOUND', '上传会话不存在');
    if (row.status !== 'pending') throw new AppError('CONFLICT', `上传会话已${row.status === 'completed' ? '完成' : '中止'}`);
    if (row.expiresAt <= Date.now()) throw new AppError('BAD_REQUEST', '上传会话已过期');
    return row;
  }

  /** 写入一个分片。重复写同一 index 会覆盖，并按差值修正已接收字节数。 */
  async putChunk(uploadId: string, index: number, data: Buffer | Readable): Promise<{ uploadedChunks: number[]; receivedBytes: number }> {
    const session = this.loadSession(uploadId);
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new AppError('BAD_REQUEST', `分片下标越界（0–${session.totalChunks - 1}）`);
    }

    const dir = this.sessionDir(session.id);
    await mkdir(dir, { recursive: true });
    const target = this.partPath(session.id, index);

    let oldSize = 0;
    try {
      oldSize = (await stat(target)).size;
    } catch {
      oldSize = 0; // 首次上传该分片
    }

    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    // 分片落在 DATA_DIR/tmp/uploads，不经过驱动（驱动只放最终对象）
    await pipeline(Buffer.isBuffer(data) ? Readable.from(data) : data, counter, createWriteStream(target));

    // 覆盖旧分片时按差值修正，否则重传会把进度和配额算多
    const delta = size - oldSize;

    const uploaded = Array.from(new Set([...session.uploadedChunks, index])).sort((a, b) => a - b);
    this.db
      .update(uploadSessions)
      .set({ uploadedChunks: uploaded, receivedBytes: session.receivedBytes + delta })
      .where(eq(uploadSessions.id, session.id))
      .run();

    return { uploadedChunks: uploaded, receivedBytes: session.receivedBytes + delta };
  }

  /**
   * 合并分片。
   *
   * 顺序流式合并（不是先拼成大文件再算 hash），保证 100 MB 文件的内存占用恒定。
   * 服务端算出的 sha256 与客户端声明值不一致时，已写入的对象会被删除并报错。
   */
  async complete(uploadId: string, expectedSha256: string): Promise<CompleteResult> {
    const session = this.loadSession(uploadId);

    const expected = new Set(Array.from({ length: session.totalChunks }, (_, i) => i));
    const got = new Set(session.uploadedChunks);
    const missing = [...expected].filter((i) => !got.has(i));
    if (missing.length > 0) {
      throw new AppError('BAD_REQUEST', '分片未上传完整', { missingChunks: missing.slice(0, 20) });
    }

    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });

    const partPaths = Array.from({ length: session.totalChunks }, (_, i) => this.partPath(session.id, i));
    const merged = Readable.from(
      (async function* () {
        for (const p of partPaths) yield* createReadStream(p);
      })(),
    );

    // 先写到一个临时 key，拿到真实 sha256 后再决定最终 key
    const tmpKey = `${session.appId}/__tmp__/${session.id}`;
    await this.driver.put(tmpKey, merged.pipe(meter));

    const sha256 = hash.digest('hex');
    if (sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      await this.driver.delete(tmpKey);
      await this.cleanupSession(session.id);
      throw new AppError('BAD_REQUEST', 'sha256 校验不一致，文件可能已损坏', {
        expected: expectedSha256,
        actual: sha256,
      });
    }

    // 秒传：同应用已存在相同内容时复用，不保留第二份副本
    const existing = this.db
      .select()
      .from(files)
      .where(and(eq(files.appId, session.appId), eq(files.sha256, sha256), isNull(files.deletedAt)))
      .get();

    let fileId: string;
    let dedup = false;
    if (existing) {
      await this.driver.delete(tmpKey);
      fileId = existing.id;
      dedup = true;
    } else {
      const finalKey = buildStorageKey(session.appId, sha256);
      if (finalKey !== tmpKey) {
        const src = await this.driver.get(tmpKey);
        await this.driver.put(finalKey, src);
        await this.driver.delete(tmpKey);
      }
      fileId = newId();
      this.db
        .insert(files)
        .values({
          id: fileId,
          appId: session.appId,
          ownerId: session.uploaderId,
          filename: session.filename,
          mime: session.mime,
          sizeBytes: size,
          sha256,
          storageKey: finalKey,
          createdAt: Date.now(),
          deletedAt: null,
        })
        .run();
    }

    this.db
      .update(uploadSessions)
      .set({ status: 'completed', fileId })
      .where(eq(uploadSessions.id, session.id))
      .run();
    await this.cleanupSession(session.id);

    return { fileId, sizeBytes: size, sha256, dedup };
  }

  private async cleanupSession(uploadId: string): Promise<void> {
    await rm(this.sessionDir(uploadId), { recursive: true, force: true });
  }

  /** 中止并清理。 */
  async abort(uploadId: string): Promise<void> {
    const session = this.db.select().from(uploadSessions).where(eq(uploadSessions.id, uploadId)).get();
    if (!session) throw new AppError('NOT_FOUND', '上传会话不存在');
    this.db.update(uploadSessions).set({ status: 'aborted' }).where(eq(uploadSessions.id, uploadId)).run();
    await this.cleanupSession(uploadId);
  }

  getFile(fileId: string, appId: string) {
    const row = this.db.select().from(files).where(eq(files.id, fileId)).get();
    // 跨应用访问一律 404：不泄露资源是否存在
    if (!row || row.appId !== appId || row.deletedAt !== null) throw new AppError('NOT_FOUND', '文件不存在');
    return row;
  }

  /**
   * 清理过期会话。
   *
   * 用 setInterval 而不是引入队列中间件 —— 自托管单机场景不值得为此增加一个依赖。
   * 定时器 unref()，避免它拖住进程退出（测试里尤其明显）。
   */
  startJanitor(intervalMs: number = 60 * 60 * 1000): NodeJS.Timeout {
    const timer = setInterval(() => {
      try {
        this.sweepExpiredSessions();
      } catch {
        // 清理失败不应影响主流程，下一轮再试
      }
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  sweepExpiredSessions(): number {
    const expired = this.db
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.status, 'pending'), sql`${uploadSessions.expiresAt} <= ${Date.now()}`))
      .all();
    for (const s of expired) {
      this.db.update(uploadSessions).set({ status: 'aborted' }).where(eq(uploadSessions.id, s.id)).run();
      void rm(this.sessionDir(s.id), { recursive: true, force: true });
    }
    return expired.length;
  }
}
