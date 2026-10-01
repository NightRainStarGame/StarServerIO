import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { SsioClient } from '@ssio/core';

/**
 * 分片上传本地文件。
 *
 * 服务端对 chunkSize 有硬约束（1–16 MiB），所以不能拿文件大小直接当 chunkSize：
 * 小文件也必须声明 ≥1 MiB，否则 init 会被拒。
 */
const MIN_CHUNK = 1024 * 1024;
const DEFAULT_CHUNK = 4 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

export interface UploadResult {
  fileId: string;
  sizeBytes: number;
  sha256: string;
  dedup: boolean;
  elapsedMs: number;
}

export async function uploadFile(
  client: SsioClient,
  filePath: string,
  opts: { chunkSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<UploadResult> {
  const startedAt = Date.now();
  const size = statSync(filePath).size;

  const requested = opts.chunkSize ?? Math.min(DEFAULT_CHUNK, Math.max(MIN_CHUNK, size));
  const chunkSize = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, requested));

  const init = await client.files.initUpload({ filename: basename(filePath), totalSize: size, chunkSize });
  const totalChunks = init.totalChunks;

  const fd = openSync(filePath, 'r');
  const buf = Buffer.alloc(chunkSize);
  const hash = createHash('sha256');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const read = readSync(fd, buf, 0, chunkSize, i * chunkSize);
      const slice = buf.subarray(0, read);
      hash.update(slice);
      await client.files.putChunk(init.uploadId, i, new Uint8Array(slice));
      opts.onProgress?.(i + 1, totalChunks);
    }
  } finally {
    closeSync(fd);
  }

  const sha256 = hash.digest('hex');
  const done = await client.files.complete(init.uploadId, { sha256 });
  return { fileId: done.fileId, sizeBytes: done.sizeBytes, sha256: done.sha256, dedup: done.dedup, elapsedMs: Date.now() - startedAt };
}
