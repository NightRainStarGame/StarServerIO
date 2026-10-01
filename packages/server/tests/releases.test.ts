import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickLatest, rolloutBucket, type ReleaseRow } from '../src/release/selector.js';
import type { TestServer } from './helpers.js';
import { createApp, createTestServer, issueKey } from './helpers.js';

function row(over: Partial<ReleaseRow> & { version: string }): ReleaseRow {
  return {
    id: `rel-${over.version}`,
    channel: 'stable',
    platform: 'win',
    arch: 'any',
    fileId: 'file-1',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    notesMd: null,
    mandatory: false,
    minVersion: null,
    rolloutPercent: 100,
    published: true,
    downloadCount: 0,
    createdAt: 1,
    deletedAt: null,
    ...over,
  };
}

/** 找一个落在指定灰度区间的 clientId，让「命中/未命中」两种情形都能稳定复现。 */
function clientIdWith(bucketUnder: number, wantHit: boolean, version = '1.2.0'): string {
  for (let i = 0; i < 5000; i++) {
    const id = `client-${i}`;
    const hit = rolloutBucket(id, version) < bucketUnder;
    if (hit === wantHit) return id;
  }
  throw new Error('找不到满足灰度条件的 clientId');
}

describe('latest 判定（纯函数）', () => {
  it('场景 1：客户端已是最新 → 无更新', () => {
    const r = pickLatest([row({ version: '1.2.0' })], { platform: 'win', channel: 'stable', current: '1.2.0' });
    expect(r.hasUpdate).toBe(false);
  });

  it('场景 2：普通更新（非强制）', () => {
    const r = pickLatest([row({ version: '1.3.0' })], { platform: 'win', channel: 'stable', current: '1.2.0' });
    expect(r.hasUpdate).toBe(true);
    if (r.hasUpdate) {
      expect(r.release.version).toBe('1.3.0');
      expect(r.mandatory).toBe(false);
    }
  });

  it('场景 3：mandatory 标记生效', () => {
    const r = pickLatest([row({ version: '1.3.0', mandatory: true })], {
      platform: 'win',
      channel: 'stable',
      current: '1.2.0',
    });
    expect(r.hasUpdate && r.mandatory).toBe(true);
  });

  it('场景 4：低于 minVersion 时强制升级，且不受灰度限制', () => {
    const r = pickLatest([row({ version: '2.0.0', minVersion: '1.5.0', rolloutPercent: 0 })], {
      platform: 'win',
      channel: 'stable',
      current: '1.2.0',
      clientId: 'someone',
    });
    // rolloutPercent=0 本应无人命中，但 minVersion 强制覆盖灰度
    expect(r.hasUpdate).toBe(true);
    if (r.hasUpdate) expect(r.mandatory).toBe(true);
  });

  it('场景 5：灰度命中', () => {
    const id = clientIdWith(30, true, '1.3.0');
    const r = pickLatest([row({ version: '1.3.0', rolloutPercent: 30 })], {
      platform: 'win',
      channel: 'stable',
      current: '1.2.0',
      clientId: id,
    });
    expect(r.hasUpdate).toBe(true);
  });

  it('场景 6：灰度未命中 → 不推送', () => {
    const id = clientIdWith(30, false, '1.3.0');
    const r = pickLatest([row({ version: '1.3.0', rolloutPercent: 30 })], {
      platform: 'win',
      channel: 'stable',
      current: '1.2.0',
      clientId: id,
    });
    expect(r.hasUpdate).toBe(false);
  });

  it('场景 7：platform=any 的记录对所有平台生效', () => {
    const r = pickLatest([row({ version: '1.3.0', platform: 'any' })], {
      platform: 'linux',
      channel: 'stable',
      current: '1.2.0',
    });
    expect(r.hasUpdate).toBe(true);
  });

  it('场景 8：未发布的版本不返回', () => {
    const r = pickLatest([row({ version: '1.3.0', published: false })], {
      platform: 'win',
      channel: 'stable',
      current: '1.2.0',
    });
    expect(r.hasUpdate).toBe(false);
  });

  it('多候选取 semver 最高，而不是字符串最大', () => {
    const r = pickLatest(
      [row({ version: '1.9.0' }), row({ version: '1.10.0' }), row({ version: '1.2.0' })],
      { platform: 'win', channel: 'stable', current: '1.0.0' },
    );
    expect(r.hasUpdate && r.release.version).toBe('1.10.0');
  });

  it('渠道不匹配时不返回', () => {
    const r = pickLatest([row({ version: '1.3.0', channel: 'beta' })], {
      platform: 'win',
      channel: 'stable',
      current: '1.2.0',
    });
    expect(r.hasUpdate).toBe(false);
  });

  it('灰度分桶稳定：同一 clientId+version 结果不变，且与版本相关', () => {
    expect(rolloutBucket('abc', '1.0.0')).toBe(rolloutBucket('abc', '1.0.0'));
    expect(rolloutBucket('abc', '1.0.0')).not.toBe(rolloutBucket('abc', '1.0.1'));
  });
});

describe('Release 接口', () => {
  let t: TestServer;
  let apiKey: string;
  let appId: string;
  let fileId: string;

  beforeAll(async () => {
    t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'rel-app');
    appId = app.id;
    apiKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['storage:read', 'storage:write', 'release:read', 'release:write'] });

    // 先传一个文件，release 必须挂在真实文件上
    const init = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', apiKey)
      .send({ filename: 'setup.exe', totalSize: 1024 * 1024, chunkSize: 1024 * 1024 });
    const uploadId = (init.body as { uploadId: string }).uploadId;
    await t.request
      .put(`/v1/storage/uploads/${uploadId}/chunks/0`)
      .set('X-API-Key', apiKey)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(1024 * 1024, 7));
    const payload = Buffer.alloc(1024 * 1024, 7);
    const done = await t.request.post(`/v1/storage/uploads/${uploadId}/complete`).set('X-API-Key', apiKey).send({
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    fileId = (done.body as { fileId: string }).fileId;
  });

  afterAll(() => t.cleanup());

  it('创建后默认未发布，latest 不返回；发布后返回', async () => {
    const created = await t.request
      .post('/v1/releases')
      .set('X-API-Key', apiKey)
      .send({ channel: 'stable', platform: 'win', arch: 'x64', version: '1.1.0', fileId });
    expect(created.status).toBe(201);
    expect(created.body.published).toBe(false);

    const before = await t.request
      .get('/v1/releases/latest')
      .set('X-API-Key', apiKey)
      .query({ platform: 'win', channel: 'stable', arch: 'x64', current: '1.0.0' });
    expect(before.status).toBe(200);
    expect(before.body.hasUpdate).toBe(false);

    const patched = await t.request.patch(`/v1/releases/${created.body.id}`).set('X-API-Key', apiKey).send({ published: true });
    expect(patched.status).toBe(200);

    const after = await t.request
      .get('/v1/releases/latest')
      .set('X-API-Key', apiKey)
      .query({ platform: 'win', channel: 'stable', arch: 'x64', current: '1.0.0' });
    expect(after.body.hasUpdate).toBe(true);
    expect(after.body.version).toBe('1.1.0');
    expect(after.body.size).toBe(1024 * 1024);
    expect(after.body.url).toContain('/v1/storage/raw/');
  });

  it('同渠道同版本重复创建 → 409', async () => {
    const res = await t.request
      .post('/v1/releases')
      .set('X-API-Key', apiKey)
      .send({ channel: 'stable', platform: 'win', arch: 'x64', version: '1.1.0', fileId });
    expect(res.status).toBe(409);
  });

  it('非法版本号 → 400', async () => {
    const res = await t.request
      .post('/v1/releases')
      .set('X-API-Key', apiKey)
      .send({ channel: 'stable', platform: 'win', arch: 'x64', version: 'v1.x', fileId });
    expect(res.status).toBe(400);
  });

  it('download 返回签名 URL 并累加下载计数', async () => {
    const list = await t.request.get('/v1/releases').set('X-API-Key', apiKey).query({ channel: 'stable' });
    const id = (list.body as Array<{ id: string }>)[0]!.id;

    const d1 = await t.request.post(`/v1/releases/${id}/download`).set('X-API-Key', apiKey);
    expect(d1.status).toBe(200);
    expect(d1.body.url).toContain('/v1/storage/raw/');
    await t.request.post(`/v1/releases/${id}/download`).set('X-API-Key', apiKey);

    const after = await t.request.get(`/v1/releases/${id}`).set('X-API-Key', apiKey);
    expect(after.body.downloadCount).toBe(2);
  });

  it('下架后不再出现在 latest', async () => {
    const created = await t.request
      .post('/v1/releases')
      .set('X-API-Key', apiKey)
      .send({ channel: 'stable', platform: 'win', arch: 'x64', version: '2.0.0', fileId, published: true });
    const id = created.body.id as string;
    const del = await t.request.delete(`/v1/releases/${id}`).set('X-API-Key', apiKey);
    expect(del.status).toBe(200);

    const latest = await t.request
      .get('/v1/releases/latest')
      .set('X-API-Key', apiKey)
      .query({ platform: 'win', channel: 'stable', arch: 'x64', current: '1.1.0' });
    expect(latest.body.hasUpdate).toBe(false);
  });

  it('被 release 引用的文件不能直接删除', async () => {
    const res = await t.request.delete(`/v1/storage/files/${fileId}`).set('X-API-Key', apiKey);
    expect(res.status).toBe(409);
  });
});
