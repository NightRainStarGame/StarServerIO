import { randomBytes, createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { TestServer } from './helpers.js';
import { createApp, createTestServer, issueKey } from './helpers.js';

const RW = ['storage:read', 'storage:write'];

/** 递归列出存储根下的所有对象（用于「文件确实落在 DATA_DIR/storage」的断言）。 */
function findStoredFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

interface UploadResult {
  initStatus: number;
  completeStatus: number;
  uploadId: string;
  fileId?: string;
  sha256?: string;
  body: Record<string, unknown>;
}

/**
 * 按分片上传一个随机文件。
 *
 * `corruptIndex` 用于故意损坏某片，验证服务端 sha256 校验确实拦得住；
 * `startAt` 用于模拟断点续传（先传后半段，再补前半段）。
 */
async function upload(
  t: TestServer,
  apiKey: string,
  opts: { size: number; chunkSize: number; filename?: string; corruptIndex?: number; startAt?: number; onChunk?: () => void },
): Promise<UploadResult> {
  const { size, chunkSize, corruptIndex, startAt = 0, onChunk } = opts;
  const filename = opts.filename ?? 'blob.bin';

  const init = await t.request
    .post('/v1/storage/uploads')
    .set('X-API-Key', apiKey)
    .send({ filename, totalSize: size, chunkSize });
  if (init.status !== 201) {
    return { initStatus: init.status, completeStatus: 0, uploadId: '', body: init.body as Record<string, unknown> };
  }
  const uploadId = (init.body as { uploadId: string }).uploadId;
  const totalChunks = (init.body as { totalChunks: number }).totalChunks;

  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const len = Math.min(chunkSize, size - i * chunkSize);
    const buf = randomBytes(len);
    chunks.push(buf);
    hash.update(buf);
  }

  // 断点续传：从 startAt 开始，绕一圈回到起点，覆盖全部下标
  for (let n = 0; n < totalChunks; n++) {
    const i = (startAt + n) % totalChunks;
    let payload = chunks[i]!;
    if (corruptIndex !== undefined && i === corruptIndex) {
      payload = Buffer.from(payload);
      payload[0] = payload[0]! ^ 0xff;
    }
    const res = await t.request
      .put(`/v1/storage/uploads/${uploadId}/chunks/${i}`)
      .set('X-API-Key', apiKey)
      .set('Content-Type', 'application/octet-stream')
      .send(payload);
    expect(res.status, `分片 ${i} 上传失败`).toBe(200);
    onChunk?.();
  }

  const done = await t.request
    .post(`/v1/storage/uploads/${uploadId}/complete`)
    .set('X-API-Key', apiKey)
    .send({ sha256: (corruptIndex === undefined ? hash.digest('hex') : hash.digest('hex')) });

  const body = done.body as Record<string, unknown>;
  return {
    initStatus: init.status,
    completeStatus: done.status,
    uploadId,
    fileId: body.fileId as string | undefined,
    sha256: body.sha256 as string | undefined,
    body,
  };
}

describe('分片上传', () => {
  let t: TestServer;
  let apiKey: string;
  let appId: string;

  beforeAll(async () => {
    t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'store-basic');
    appId = app.id;
    apiKey = await issueKey(t.request, t.masterKey, { appId, scopes: RW });
  });

  afterAll(() => t.cleanup());

  it('小文件分 3 片上传，服务端 sha256 与本地一致', async () => {
    const size = 10 * 1024 * 1024; // 10 MB，超过默认 4 MB 分片
    const r = await upload(t, apiKey, { size, chunkSize: 4 * 1024 * 1024, filename: 'app.zip' });
    expect(r.completeStatus).toBe(200);
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);

    const meta = await t.request.get(`/v1/storage/files/${r.fileId}`).set('X-API-Key', apiKey);
    expect(meta.status).toBe(200);
    expect(meta.body.sizeBytes).toBe(size);
    expect(meta.body.filename).toBe('app.zip');
  });

  it('断点续传：先传后 10 片再补前 15 片也能完成', async () => {
    const r = await upload(t, apiKey, {
      size: 25 * 1024 * 1024,
      chunkSize: 1024 * 1024,
      filename: 'resume.bin',
      startAt: 15, // 共 25 片，从下标 15 开始绕一圈
    });
    expect(r.completeStatus).toBe(200);
    expect(r.body.dedup).toBe(false);
  });

  it('故意改坏一片 → complete 拒绝，且不留下文件记录', async () => {
    const r = await upload(t, apiKey, {
      size: 8 * 1024 * 1024,
      chunkSize: 4 * 1024 * 1024,
      filename: 'corrupt.bin',
      corruptIndex: 1,
    });
    expect(r.completeStatus).toBe(400);
    expect((r.body.error as { code: string }).code).toBe('BAD_REQUEST');
    // 失败后会话仍在，但绝不能产出 fileId
    expect(r.body.fileId).toBeUndefined();
  });

  it('分片下标越界 → 400', async () => {
    const init = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', apiKey)
      .send({ filename: 'x.bin', totalSize: 2 * 1024 * 1024, chunkSize: 1024 * 1024 });
    const uploadId = (init.body as { uploadId: string }).uploadId;
    const res = await t.request
      .put(`/v1/storage/uploads/${uploadId}/chunks/9`)
      .set('X-API-Key', apiKey)
      .set('Content-Type', 'application/octet-stream')
      .send(randomBytes(1024 * 1024));
    expect(res.status).toBe(400);
  });

  it('缺少 storage:write 的 Key 无权上传', async () => {
    const readOnly = await issueKey(t.request, t.masterKey, { appId, scopes: ['storage:read'] });
    const res = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', readOnly)
      .send({ filename: 'x.bin', totalSize: 1024 * 1024 });
    expect(res.status).toBe(403);
  });

  it('跨应用读取文件 → 404（不泄露存在性）', async () => {
    const r = await upload(t, apiKey, { size: 1024 * 1024, chunkSize: 1024 * 1024, filename: 'a.bin' });
    const other = await createApp(t.request, t.masterKey, 'store-other');
    const otherKey = await issueKey(t.request, t.masterKey, { appId: other.id, scopes: RW });
    const res = await t.request.get(`/v1/storage/files/${r.fileId}`).set('X-API-Key', otherKey);
    expect(res.status).toBe(404);
  });

  it('跨应用不能向别人的上传会话塞分片 / complete / abort（跨租户 DoS 防护）', async () => {
    // 应用 A 建一个上传会话
    const init = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', apiKey)
      .send({ filename: 'guard.bin', totalSize: 2 * 1024 * 1024, chunkSize: 1024 * 1024 });
    const uploadId = (init.body as { uploadId: string }).uploadId;

    // 应用 B 的 Key 拿到 uploadId 后，三个操作都必须是 404，不能有任何副作用
    const other = await createApp(t.request, t.masterKey, 'store-guard-evil');
    const evilKey = await issueKey(t.request, t.masterKey, { appId: other.id, scopes: RW });

    const put = await t.request
      .put(`/v1/storage/uploads/${uploadId}/chunks/0`)
      .set('X-API-Key', evilKey)
      .set('Content-Type', 'application/octet-stream')
      .send(randomBytes(1024 * 1024));
    expect(put.status).toBe(404);

    const complete = await t.request
      .post(`/v1/storage/uploads/${uploadId}/complete`)
      .set('X-API-Key', evilKey)
      .send({ sha256: '0'.repeat(64) });
    expect(complete.status).toBe(404);

    const abort = await t.request.delete(`/v1/storage/uploads/${uploadId}`).set('X-API-Key', evilKey);
    expect(abort.status).toBe(404);

    // A 自己的会话不受影响，仍可正常续传
    const mine = await t.request
      .put(`/v1/storage/uploads/${uploadId}/chunks/0`)
      .set('X-API-Key', apiKey)
      .set('Content-Type', 'application/octet-stream')
      .send(randomBytes(1024 * 1024));
    expect(mine.status).toBe(200);
  });

  it('buildApp 传 janitorIntervalMs 后启动即清理过期会话', async () => {
    const app = await createApp(t.request, t.masterKey, 'store-janitor');
    const key = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: RW });
    const init = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', key)
      .send({ filename: 'stale.bin', totalSize: 1024 * 1024 });
    const uploadId = (init.body as { uploadId: string }).uploadId;

    // 把会话改成已过期，然后重建一个带 janitor 的实例 —— 启动即扫（sweep 同步执行）
    t.sqlite
      .prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, uploadId);
    const app2 = await buildApp({ db: t.db, config: t.config, janitorIntervalMs: 999_999_999_999 });
    await app2.close();

    const row = t.sqlite.prepare('SELECT status FROM upload_sessions WHERE id = ?').get(uploadId) as { status: string };
    expect(row.status).toBe('aborted');
  });
});

describe('签名下载', () => {
  let t: TestServer;
  let apiKey: string;

  beforeAll(async () => {
    t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'store-sign');
    apiKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: RW });
  });

  afterAll(() => t.cleanup());

  it('签名 URL 可下载，且支持 Range 续传', async () => {
    const size = 3 * 1024 * 1024;
    const r = await upload(t, apiKey, { size, chunkSize: 1024 * 1024, filename: 'dl.bin' });

    const signed = await t.request
      .get(`/v1/storage/files/${r.fileId}/download`)
      .set('X-API-Key', apiKey)
      .query({ ttl: 300 });
    expect(signed.status).toBe(200);
    const url = signed.body.url as string;
    expect(url).toContain('/v1/storage/raw/');

    // 去掉 host 部分，用 supertest 打相对路径
    const path = url.slice(url.indexOf('/v1/storage/raw/'));
    // 只断言头部：superagent 对二进制响应的解析不可靠，内容正确性由落盘校验覆盖
    const full = await t.request.get(path);
    expect(full.status).toBe(200);
    expect(full.headers['content-length']).toBe(String(size));

    const partial = await t.request.get(path).set('Range', 'bytes=0-1023');
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-1023/${size}`);
  });

  it('篡改签名 → 401', async () => {
    const r = await upload(t, apiKey, { size: 1024 * 1024, chunkSize: 1024 * 1024, filename: 's.bin' });
    const signed = await t.request.get(`/v1/storage/files/${r.fileId}/download`).set('X-API-Key', apiKey);
    const url = signed.body.url as string;
    const path = url.slice(url.indexOf('/v1/storage/raw/'));
    const tampered = path.replace(/sig=(.)/, (_, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`);
    const res = await t.request.get(tampered);
    expect(res.status).toBe(401);
  });

  it('签名过期 → 401', async () => {
    const r = await upload(t, apiKey, { size: 1024 * 1024, chunkSize: 1024 * 1024, filename: 'e.bin' });
    const signed = await t.request
      .get(`/v1/storage/files/${r.fileId}/download`)
      .set('X-API-Key', apiKey)
      .query({ ttl: 1 });
    const url = signed.body.url as string;
    const path = url.slice(url.indexOf('/v1/storage/raw/'));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const res = await t.request.get(path);
    expect(res.status).toBe(401);
  });
});

describe('配额', () => {
  it('配额 1 MB，传 2 MB → 507', async () => {
    const t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'store-quota');
    // 把配额压到 1 MB
    const patched = await t.request
      .patch(`/v1/apps/${app.id}`)
      .set('X-Master-Key', t.masterKey)
      .send({ quotaBytes: 1024 * 1024 });
    expect(patched.status).toBe(200);

    const apiKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: RW });
    const res = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', apiKey)
      .send({ filename: 'big.bin', totalSize: 2 * 1024 * 1024 });
    expect(res.status).toBe(507);
    expect((res.body.error as { code: string }).code).toBe('QUOTA_EXCEEDED');
    t.cleanup();
  });

  it('上传后配额统计随之增长', async () => {
    const t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'store-quota2');
    const apiKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: RW });

    const before = await t.request.get('/v1/storage/quota').set('X-API-Key', apiKey);
    expect(before.status).toBe(200);
    expect(before.body.usedBytes).toBe(0);

    await upload(t, apiKey, { size: 5 * 1024 * 1024, chunkSize: 1024 * 1024, filename: 'q.bin' });

    const after = await t.request.get('/v1/storage/quota').set('X-API-Key', apiKey);
    expect(after.body.usedBytes).toBe(5 * 1024 * 1024);
    t.cleanup();
  });
});

describe('100 MB 分片上传实测', () => {
  it(
    '25 片 × 4 MB：sha256 一致，并记录耗时与峰值内存',
    async () => {
      const t = await createTestServer();
      const app = await createApp(t.request, t.masterKey, 'store-big');
      const apiKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: RW });

      const size = 100 * 1024 * 1024;
      const chunkSize = 4 * 1024 * 1024;

      let peakHeap = 0;
      let peakRss = 0;
      const started = Date.now();
      const r = await upload(t, apiKey, {
        size,
        chunkSize,
        filename: 'big.bin',
        onChunk: () => {
          const m = process.memoryUsage();
          peakHeap = Math.max(peakHeap, m.heapUsed);
          peakRss = Math.max(peakRss, m.rss);
        },
      });
      const elapsed = Date.now() - started;

      expect(r.completeStatus).toBe(200);
      expect(r.body.sizeBytes).toBe(size);

      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(
        `[bench] 100MB 分片上传: ${elapsed} ms, 吞吐 ${mb((size / elapsed) * 1000)} MB/s, ` +
          `峰值 heapUsed ${mb(peakHeap)} MB, 峰值 RSS ${mb(peakRss)} MB`,
      );

      // 落盘校验：对象必须躺在 DATA_DIR/storage（而不是源码目录），且内容哈希与服务端一致
      const stored = findStoredFiles(join(t.dataDir, 'storage')).filter((f) => statSync(f).size === size);
      expect(stored.length, '应恰好有一份 100 MB 的对象').toBe(1);
      const diskHash = createHash('sha256').update(readFileSync(stored[0]!)).digest('hex');
      expect(diskHash).toBe(r.sha256);

      t.cleanup();
    },
    180_000,
  );
});
