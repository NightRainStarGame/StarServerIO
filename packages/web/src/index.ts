import { createClient, type KeyValueStorage, type SsioClient } from '@ssio/core';

export type {
  AnnouncementsNamespace,
  AuthNamespace,
  CardsNamespace,
  ClientOptions,
  FilesNamespace,
  ReleasesNamespace,
  SsioClient,
} from '@ssio/core';
export { AuthError, SsioError, createClient } from '@ssio/core';

/** 浏览器 localStorage 持久化；隐私模式下 localStorage 可能被禁，自动退化为内存。 */
export function localStorageKeys(namespace = 'ssio'): KeyValueStorage {
  const mem: Record<string, string> = {};
  const k = (key: string) => `${namespace}.${key}`;
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(k(key)) ?? mem[key] ?? null;
      } catch {
        return mem[key] ?? null;
      }
    },
    set(key, value) {
      mem[key] = value;
      try {
        globalThis.localStorage?.setItem(k(key), value);
      } catch {
        /* 隐私模式 / 存储被禁：退化为内存即可 */
      }
    },
    remove(key) {
      delete mem[key];
      try {
        globalThis.localStorage?.removeItem(k(key));
      } catch {
        /* noop */
      }
    },
  };
}

export interface WebClientOptions {
  baseUrl: string;
  apiKey?: string;
  storage?: KeyValueStorage;
  timeoutMs?: number;
}

export type UploadResult = { fileId: string; sizeBytes: number; sha256: string; dedup: boolean };

export type SsioWebClient = SsioClient & {
  /** 实例方法形态（client 已闭包绑定，不需要外部再传）。 */
  upload: (file: File | Blob, opts?: UploadOptions) => Promise<UploadResult>;
};

/** 建一个浏览器端 client：token 存 localStorage，附加分片上传。 */
export function createWebClient(opts: WebClientOptions): SsioWebClient {
  const client = createClient({ ...opts, storage: opts.storage ?? localStorageKeys() });
  // 闭包绑定 client：直接放 uploadFile 会让 client 实参错位成 file
  return Object.assign(client, { upload: (file: File | Blob, o: UploadOptions = {}) => uploadFile(client, file, o) });
}

export interface UploadProgress {
  /** 已接收字节。 */
  uploaded: number;
  total: number;
  /** 0-100。 */
  percent: number;
}

export interface UploadOptions {
  /** 默认 4 MiB（服务端允许 1-16 MiB）。 */
  chunkSize?: number;
  /** 并发分片数，默认 3。 */
  concurrency?: number;
  onProgress?: (p: UploadProgress) => void;
  /** 调用方已算好的 sha256（hex）；不传则用 SubtleCrypto 读整个文件计算。 */
  sha256?: string;
}

/**
 * 浏览器分片上传。
 *
 * - 并发 3 片推进度，onProgress 严格单调递增；
 * - 服务端会重算 sha256 并以它为准，传错必然在 complete 时失败；
 * - 不传 sha256 时用 SubtleCrypto 一次读入整个文件 —— **超大文件（如 >2 GB）
 *   会双倍占内存**，那种场景请用 @ssio/node（流式）。
 */
export async function uploadFile(client: SsioClient, file: File | Blob, opts: UploadOptions = {}): Promise<UploadResult> {
  const chunkSize = opts.chunkSize ?? 4 * 1024 * 1024;
  const concurrency = opts.concurrency ?? 3;
  const name = file instanceof File ? file.name : 'blob';
  const total = file.size;

  const init = await client.files.initUpload({ filename: name, totalSize: total, chunkSize });
  const { uploadId, totalChunks } = init;

  let uploaded = 0;
  const report = (): void => {
    opts.onProgress?.({ uploaded, total, percent: total === 0 ? 100 : Math.floor((uploaded / total) * 100) });
  };
  report();

  // 简单 worker pool：队列 + 固定并发
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= totalChunks) return;
      const start = i * chunkSize;
      const blob = file.slice(start, Math.min(start + chunkSize, total));
      // 分片失败让上层抛：SDK 不替业务决定重试语义（core 传输层已重试过）
      await client.files.putChunk(uploadId, i, blob);
      uploaded += blob.size;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, totalChunks) }, worker));

  const sha256 = opts.sha256 ?? (await sha256OfBlob(file));
  const done = await client.files.complete(uploadId, { sha256 });
  report();
  return done;
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
