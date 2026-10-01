// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createWebClient } from '../src/index.js';
import type { ClientOptions } from '@ssio/core';

/** mock SSIO：只实现上传协议三步，校验收到的请求形态。 */
function createUploadMock() {
  const puts: Array<{ index: number; size: number; at: number }> = [];
  let completeBody: { sha256?: string } | null = null;

  const fetchImpl: NonNullable<ClientOptions['fetchImpl']> = (input, init) => {
    const url = new URL(input, 'http://ssio.test');
    const path = url.pathname + url.search;
    const method = init?.method ?? 'GET';

    if (method === 'POST' && path === '/v1/storage/uploads') {
      const body = JSON.parse(String(init?.body)) as { filename: string; totalSize: number };
      const totalChunks = Math.ceil(body.totalSize / 4 / 1024 / 1024);
      return json(201, { uploadId: 'u1', chunkSize: 4 * 1024 * 1024, totalChunks, expiresAt: 1 });
    }
    if (method === 'PUT' && /\/v1\/storage\/uploads\/u1\/chunks\/(\d+)/.test(url.pathname)) {
      const index = Number(/chunks\/(\d+)/.exec(url.pathname)![1]);
      const raw = init?.body as Blob;
      puts.push({ index, size: raw.size, at: Date.now() });
      return json(200, { uploadedChunks: [index], receivedBytes: raw.size });
    }
    if (method === 'POST' && path === '/v1/storage/uploads/u1/complete') {
      completeBody = JSON.parse(String(init?.body));
      return json(200, { fileId: 'f1', sizeBytes: 0, sha256: (completeBody as { sha256: string }).sha256, dedup: false });
    }
    return json(200, {});
  };
  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  return { fetchImpl, puts, getComplete: () => completeBody };
}

describe('web 分片上传', () => {
  it('10 MB 分 3 片并发上传，进度单调递增到 100，sha256 传给 complete', async () => {
    const mock = createUploadMock();
    const client = createWebClient({ baseUrl: 'http://ssio.test', apiKey: 'ssio_live_x', fetchImpl: mock.fetchImpl, storage: { get: () => null, set: () => {}, remove: () => {} } });

    const size = 10 * 1024 * 1024;
    const file = new File([new Uint8Array(size)], 'app.bin', { type: 'application/octet-stream' });

    const percents: number[] = [];
    const done = await client.upload(file, {
      chunkSize: 4 * 1024 * 1024,
      concurrency: 3,
      onProgress: (p) => percents.push(p.percent),
    });

    expect(done.fileId).toBe('f1');
    expect(mock.puts).toHaveLength(3);
    // 分片大小：4MB + 4MB + 2MB
    expect(mock.puts.map((p) => p.size).sort((a, b) => b - a)).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024, 2 * 1024 * 1024]);
    // 进度单调不减，最后到 100
    expect(percents[percents.length - 1]).toBe(100);
    for (let i = 1; i < percents.length; i++) expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!);
    // SubtleCrypto 算出的 sha256 是 64 位 hex 且真的传给了 complete
    expect(mock.getComplete()?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mock.getComplete()?.sha256).toBe(done.sha256);
  });

  it('onProgress 也能拿到字节数', async () => {
    const mock = createUploadMock();
    const client = createWebClient({ baseUrl: 'http://ssio.test', fetchImpl: mock.fetchImpl, storage: { get: () => null, set: () => {}, remove: () => {} } });
    const file = new File([new Uint8Array(5 * 1024 * 1024)], 'x.bin');
    const seen: number[] = [];
    await client.upload(file, { chunkSize: 4 * 1024 * 1024, onProgress: (p) => seen.push(p.uploaded) });
    expect(seen[seen.length - 1]).toBe(5 * 1024 * 1024);
    expect(mock.puts).toHaveLength(2);
  });
});
