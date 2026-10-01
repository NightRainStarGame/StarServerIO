import type { Readable } from 'node:stream';

/**
 * 存储驱动抽象。
 *
 * P2 只实现 LocalDriver，但接口按「将来要换 S3」来设计：
 * 驱动只认识 key，不认识 appId / 业务表，也不直接产生对外 URL（对外 URL 由 signUrl 生成）。
 *
 * 扩展 S3Driver 时实现同一组方法即可，路由层无需改动；
 * 唯一需要注意的是 `signUrl` —— S3 应返回预签名 URL，而 Local 返回后端代理地址 + 自签参数。
 */
export interface StorageDriver {
  /** 写入。返回实际写入字节数（用于配额核算）。 */
  put(key: string, data: Buffer | Readable): Promise<{ size: number }>;
  /** 全量读取。 */
  get(key: string): Promise<Readable>;
  /** 区间读取，断点续传用。end 为闭区间（含）。 */
  getRange(key: string, start: number, end: number): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** 生成有时效的下载地址。 */
  signUrl(key: string, ttlSec: number): Promise<string>;
  /** 返回 null 表示不存在。 */
  stat(key: string): Promise<{ size: number } | null>;
}

/** 默认分片大小 4 MiB；允许范围 1–16 MiB。 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 1024 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

/** 上传会话有效期：24 小时。过期由轻量定时任务清理。 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 存储 key 的形态：`<appId>/yy/mm/dd/<sha256>`。
 *
 * 按日期分片是为了避免单目录下文件过多（多数文件系统在单目录数万条目后 stat 会明显变慢）。
 */
export function buildStorageKey(appId: string, sha256: string, now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${appId}/${yy}/${mm}/${dd}/${sha256}`;
}

/**
 * 校验 key 是否安全。
 *
 * key 会出现在下载 URL 里（经签名保护），但签名实现若有疏漏就会变成任意文件读取，
 * 所以这里再挡一次：只允许 `[A-Za-z0-9._/-]`，且禁止 `..` 段与绝对路径。
 */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 300) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  if (key.startsWith('/') || key.startsWith('-')) return false;
  if (key.includes('..') || key.includes('//')) return false;
  return true;
}
