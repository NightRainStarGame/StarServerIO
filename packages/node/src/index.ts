import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient, SsioError, type ClientOptions, type KeyValueStorage, type SsioClient } from '@ssio/core';

export { AuthError, SsioError, createClient } from '@ssio/core';
export type {
  AnnouncementsNamespace,
  AuthNamespace,
  CardsNamespace,
  ClientOptions,
  FilesNamespace,
  ReleasesNamespace,
  SsioClient,
} from '@ssio/core';
export { createUpdater, type UpdaterApplyOptions, type UpdaterCheckResult, type UpdaterOptions } from './updater.js';

/** token 存 JSON 文件（Electron 里给个 userData 下的路径即可）。 */
export function fileTokenStorage(path: string): KeyValueStorage {
  return {
    async get(key) {
      // 单 key（ssio.tokens）存整个文件；其它 key 忽略
      if (key !== 'ssio.tokens') return null;
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (key !== 'ssio.tokens') return;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value, 'utf8');
    },
    async remove(key) {
      if (key !== 'ssio.tokens') return;
      await rm(path, { force: true });
    },
  };
}

export interface NodeClientOptions extends ClientOptions {
  /** token 文件路径；不提供则内存态。 */
  tokenFile?: string;
}

export type SsioNodeClient = SsioClient & {
  downloadToFile: typeof downloadToFile;
  verifyFile: typeof verifyFile;
};

/** Node 端 client：token 文件持久化 + 文件下载/校验。 */
export function createNodeClient(opts: NodeClientOptions): SsioNodeClient {
  const { tokenFile, ...rest } = opts;
  const client = createClient({ ...rest, storage: tokenFile ? fileTokenStorage(tokenFile) : undefined });
  return Object.assign(client, {
    downloadToFile: (url: string, dest: string, o: DownloadOptions = {}) => downloadToFile(url, dest, o),
    verifyFile: (path: string, expected: string) => verifyFile(path, expected),
  });
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
  /** total 未知时 percent 为 null。 */
  percent: number | null;
}

export interface DownloadOptions {
  expectedSha256?: string;
  onProgress?: (p: DownloadProgress) => void;
  /** 校验失败时的完整重下次数（续传不重算，从 0 重下才算一次），默认 2。 */
  maxRedownloads?: number;
  /** 下载用的 fetch（Electron 主进程想换 net.fetch 就在这里换）。 */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * 流式下载到磁盘。
 *
 * - 断点续传：dest 同目录留 `<dest>.part`，续传用 `Range: bytes=<已下>-` 请求 206 续写；
 * - 校验：下载完成后流式重算 sha256 与 expectedSha256 比对；
 * - 失败处理：不一致 → 删掉重下（从 0），最多 maxRedownloads 次，仍失败则抛错且不留下坏文件；
 * - 文件锁：`.part` 存在即视为续传点，同名 `.lock` 不引入（单机场景 .part 已够用，
 *   多进程并发下载同一目标请调用方自己加锁）。
 */
export async function downloadToFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxRedownloads = opts.maxRedownloads ?? 2;
  await mkdir(dirname(dest), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    const resumed = await resumeDownload(url, dest, opts, fetchImpl);
    if (resumed.ok) return resumed.sha256;
    // resumed.ok === false 只可能是校验失败
    if (attempt >= maxRedownloads) {
      // 重下次数用尽：不留坏文件（dest 与 .part 都可能不完整）
      await Promise.all([rm(dest, { force: true }), rm(`${dest}.part`, { force: true })]);
      throw new SsioError('CHECKSUM_MISMATCH', `sha256 校验失败（已重下 ${attempt} 次）`, 0, { url, dest });
    }
    // 从 0 重下：清掉残留
    await rm(`${dest}.part`, { force: true });
    await rm(dest, { force: true });
  }
}

/** 一次下载尝试（可能续传）。返回 ok=false 表示「下完了但校验失败」。 */
async function resumeDownload(
  url: string,
  dest: string,
  opts: DownloadOptions,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ ok: true; sha256: string } | { ok: false }> {
  const part = `${dest}.part`;
  let startAt = 0;
  try {
    startAt = (await stat(part)).size;
  } catch {
    startAt = 0;
  }

  const headers: Record<string, string> = {};
  if (startAt > 0) headers.Range = `bytes=${startAt}-`;

  const res = await fetchImpl(url, { headers });
  if (!res.ok && res.status !== 206) {
    // 续传的 Range 可能被拒（服务端不支持/文件已变）：回退整下
    if (startAt > 0) {
      await rm(part, { force: true });
      const fresh = await fetchImpl(url);
      if (!fresh.ok) throw new SsioError('NETWORK', `下载失败：HTTP ${fresh.status}`, fresh.status);
      return await streamToPart(fresh, part, 0, opts);
    }
    throw new SsioError('NETWORK', `下载失败：HTTP ${res.status}`, res.status);
  }
  // 206 时 fetch 已自动带上正确区间，从 startAt 续写
  return await streamToPart(res, part, res.status === 206 ? startAt : 0, opts);
}

async function streamToPart(
  res: Response,
  part: string,
  startAt: number,
  opts: DownloadOptions,
): Promise<{ ok: true; sha256: string } | { ok: false }> {
  const totalFromHeader = Number(res.headers.get('content-length') ?? 0) + startAt;
  const total = totalFromHeader > startAt ? totalFromHeader : null;
  let downloaded = startAt;

  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    async function* write(chunk) {
      for await (const c of chunk) {
        downloaded += (c as Buffer).length;
        opts.onProgress?.({ downloaded, total, percent: total ? Math.floor((downloaded / total) * 100) : null });
        yield c;
      }
    },
    // 续传 append；整下 overwrite
    createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' }),
  );

  const dest = part.slice(0, -'.part'.length);
  await rename(part, dest);

  if (!opts.expectedSha256) return { ok: true, sha256: '' };
  const sha256 = await sha256File(dest);
  if (sha256 === opts.expectedSha256.toLowerCase()) return { ok: true, sha256 };
  return { ok: false };
}

/** 流式计算文件 sha256（不整读进内存）。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (chunks) {
    for await (const c of chunks) hash.update(c as Buffer);
    yield ''; // pipeline 需要消费端；空产出即完成
  });
  return hash.digest('hex');
}

/** 独立校验：失败时删除文件并抛 SsioError（ updater 的 verify 语义）。 */
export async function verifyFile(path: string, expectedSha256: string): Promise<boolean> {
  const got = await sha256File(path);
  if (got !== expectedSha256.toLowerCase()) {
    await rm(path, { force: true });
    throw new SsioError('CHECKSUM_MISMATCH', `sha256 不一致，已删除本地文件：${got}`, 0, { path });
  }
  return true;
}

export { join as pathJoin };
