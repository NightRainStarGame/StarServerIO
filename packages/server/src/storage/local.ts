import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@ssio/shared';
import { isSafeKey, type StorageDriver } from './driver.js';

export interface LocalDriverOptions {
  /** 存储根目录（DATA_DIR/storage）。 */
  root: string;
  /** 签名密钥。传入 JWT_SECRET 后内部会派生子密钥，不与令牌签发共用同一把。 */
  signSecret: string;
  /** 签名 URL 指向的后端代理前缀。 */
  rawUrlPrefix?: string;
}

/**
 * 本地文件系统驱动。
 *
 * 所有 IO 走 stream + pipeline：100 MB 文件合并时不会整体进内存，
 * 峰值内存只与分片大小（默认 4 MB）相关。
 */
export class LocalDriver implements StorageDriver {
  private readonly root: string;
  private readonly hmacKey: Buffer;
  private readonly rawUrlPrefix: string;

  constructor(opts: LocalDriverOptions) {
    this.root = resolve(opts.root);
    // 派生子密钥：避免与 JWT 签发共用同一 HMAC 密钥（一处泄露不至于波及另一处）
    this.hmacKey = createHash('sha256').update(`${opts.signSecret}:storage-url`).digest();
    this.rawUrlPrefix = opts.rawUrlPrefix ?? '/v1/storage/raw';
  }

  private pathFor(key: string): string {
    if (!isSafeKey(key)) throw new AppError('BAD_REQUEST', '非法的存储 key');
    return resolve(this.root, key);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Buffer | Readable): Promise<{ size: number }> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Buffer.isBuffer(data) ? Readable.from(data) : data, counter, createWriteStream(target));
    return { size };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    if (!(await this.exists(path))) throw new AppError('NOT_FOUND', '文件不存在');
    return createReadStream(path);
  }

  async getRange(key: string, start: number, end: number): Promise<Readable> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new AppError('BAD_REQUEST', '非法的 Range');
    }
    const path = this.pathFor(key);
    const info = await this.stat(key);
    if (!info) throw new AppError('NOT_FOUND', '文件不存在');
    // 客户端可能请求越界区间，截断到文件末尾而不是报错（与 HTTP Range 语义一致）
    const safeEnd = Math.min(end, Math.max(info.size - 1, 0));
    return createReadStream(path, { start, end: safeEnd });
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async signUrl(key: string, ttlSec: number): Promise<string> {
    const exp = Date.now() + ttlSec * 1000;
    const sig = this.sign(key, exp);
    return `${this.rawUrlPrefix}/${key}?exp=${exp}&sig=${sig}`;
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.hmacKey).update(`${key}:${exp}`).digest('hex').slice(0, 32);
  }

  /** 校验签名与有效期。返回 false 时调用方应返回 401/403。 */
  verify(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp <= Date.now()) return false;
    const expected = this.sign(key, exp);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
