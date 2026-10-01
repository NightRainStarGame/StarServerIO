import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

/**
 * 软件源（P3）：包体复用 storage，所以这里也顺带验证「配额/秒传/签名下载」这条链
 * 在 registry 语境下同样成立。
 */

let t: TestServer;
let appId: string;
let rwKey: string;
let roKey: string;
let fileId: string;
let fileSha: string;

const PKG = 'my-plugin';
const CHUNK = 1024 * 1024;

/** 1 MiB 分片上传，返回 fileId。 */
async function upload(content: Buffer, filename: string): Promise<{ fileId: string; sha256: string }> {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const init = await t.request
    .post('/v1/storage/uploads')
    .set('X-API-Key', rwKey)
    .send({ filename, totalSize: content.length, chunkSize: CHUNK });
  await t.request
    .put(`/v1/storage/uploads/${init.body.uploadId as string}/chunks/0`)
    .set('X-API-Key', rwKey)
    .set('content-type', 'application/octet-stream')
    .send(content);
  const done = await t.request
    .post(`/v1/storage/uploads/${init.body.uploadId as string}/complete`)
    .set('X-API-Key', rwKey)
    .send({ sha256 });
  return { fileId: done.body.fileId as string, sha256 };
}

beforeAll(async () => {
  t = await createTestServer();
  const app = await createApp(t.request, t.masterKey, 'registry-app');
  appId = app.id;
  rwKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['source:read', 'source:write', 'storage:read', 'storage:write'] });
  roKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['source:read'] });

  const pkg = await t.request.post('/v1/registry/packages').set('X-API-Key', rwKey).send({ name: PKG });
  expect(pkg.status).toBe(201);

  const up = await upload(Buffer.alloc(CHUNK, 3), 'plugin-1.0.0.zip');
  fileId = up.fileId;
  fileSha = up.sha256;
}, 30_000);

afterAll(() => t.cleanup());

describe('软件源', () => {
  it('建包：重名 → 409', async () => {
    const dup = await t.request.post('/v1/registry/packages').set('X-API-Key', rwKey).send({ name: PKG });
    expect(dup.status).toBe(409);
  });

  it('发布版本：包体必须属于本应用', async () => {
    const ok = await t.request
      .post(`/v1/registry/packages/${PKG}/versions`)
      .set('X-API-Key', rwKey)
      .send({ version: '1.0.0', fileId, meta: { entry: 'index.js' } });
    expect(ok.status).toBe(201);
    expect(ok.body.sha256).toBe(fileSha);
    expect(ok.body.meta).toEqual({ entry: 'index.js' });

    // 别的应用的文件不能挂进来
    const other = await createApp(t.request, t.masterKey, 'registry-other');
    const otherRw = await issueKey(t.request, t.masterKey, { appId: other.id, scopes: ['source:write', 'storage:write', 'storage:read'] });
    await t.request.post('/v1/registry/packages').set('X-API-Key', otherRw).send({ name: PKG });
    const otherUpload = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', otherRw)
      .send({ filename: 'x.bin', totalSize: CHUNK, chunkSize: CHUNK });
    await t.request
      .put(`/v1/storage/uploads/${otherUpload.body.uploadId as string}/chunks/0`)
      .set('X-API-Key', otherRw)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(CHUNK, 9));
    const otherFile = await t.request
      .post(`/v1/storage/uploads/${otherUpload.body.uploadId as string}/complete`)
      .set('X-API-Key', otherRw)
      .send({ sha256: createHash('sha256').update(Buffer.alloc(CHUNK, 9)).digest('hex') });

    const cross = await t.request
      .post(`/v1/registry/packages/${PKG}/versions`)
      .set('X-API-Key', rwKey)
      .send({ version: '9.9.9', fileId: otherFile.body.fileId as string });
    expect(cross.status).toBe(404);
  }, 30_000);

  it('版本不可覆盖：重复发同版本 → 409', async () => {
    const dup = await t.request
      .post(`/v1/registry/packages/${PKG}/versions`)
      .set('X-API-Key', rwKey)
      .send({ version: '1.0.0', fileId });
    expect(dup.status).toBe(409);
  });

  it('latest 按 semver 取最大：后发旧版本不把 latest 拉回去', async () => {
    await t.request
      .post(`/v1/registry/packages/${PKG}/versions`)
      .set('X-API-Key', rwKey)
      .send({ version: '0.9.0', fileId });

    const latest = await t.request.get(`/v1/registry/packages/${PKG}/latest`).set('X-API-Key', roKey);
    expect(latest.status).toBe(200);
    expect(latest.body.version).toBe('1.0.0');

    await t.request
      .post(`/v1/registry/packages/${PKG}/versions`)
      .set('X-API-Key', rwKey)
      .send({ version: '1.10.0', fileId });

    const again = await t.request.get(`/v1/registry/packages/${PKG}/latest`).set('X-API-Key', roKey);
    expect(again.body.version).toBe('1.10.0');
  });

  it('下载：签名 URL 能取回内容，计数自增', async () => {
    const dl = await t.request
      .post(`/v1/registry/packages/${PKG}/1.0.0/download`)
      .set('X-API-Key', roKey)
      .send({});
    expect(dl.status).toBe(200);
    expect(dl.body.sha256).toBe(fileSha);

    const url = dl.body.url as string;
    const path = url.slice(url.indexOf('/v1/storage/raw/'));
    // 只断言头部：superagent 对二进制响应的解析不可靠（storage.test.ts 里踩过同一个坑），
    // 「内容哈希与上传时一致」由 storage 模块的用例覆盖，这里不重复验证
    const raw = await t.request.get(path);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-length']).toBe(String(CHUNK));
    expect(dl.body.sizeBytes).toBe(CHUNK);

    const detail = await t.request.get(`/v1/registry/packages/${PKG}`).set('X-API-Key', roKey);
    expect(detail.status).toBe(200);
    expect(detail.body.downloadCount).toBe(1);
    const versions = detail.body.versions as Array<{ version: string; downloadCount: number }>;
    expect(versions.find((v) => v.version === '1.0.0')!.downloadCount).toBe(1);
  }, 30_000);

  it('缺 source:write 的 Key 不能发包', async () => {
    const res = await t.request
      .post(`/v1/registry/packages/${PKG}/versions`)
      .set('X-API-Key', roKey)
      .send({ version: '2.0.0', fileId });
    expect(res.status).toBe(403);
  });

  it('不存在的包/版本 → 404', async () => {
    expect((await t.request.get('/v1/registry/packages/nope').set('X-API-Key', roKey)).status).toBe(404);
    expect(
      (await t.request.post(`/v1/registry/packages/${PKG}/3.0.0/download`).set('X-API-Key', roKey).send({})).status,
    ).toBe(404);
  });
});
