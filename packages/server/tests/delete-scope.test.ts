import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

/**
 * 删除类操作的独立 scope。
 *
 * 这组用例锁定的语义：**能写 ≠ 能删**。
 * 写入是可重试的（传错了再传一次），删除不是（下架的版本、删掉的文件不会自己回来），
 * 所以两者必须能分开授权 —— 给 CI 或外包发版用的 Key 只该有 write。
 *
 * 同时验证迁移通道：权限拆分后老 Key 必须能「补权限」而不是「重签」，
 * 否则每个已分发的客户端都要换 Key。
 */
describe('删除类操作需要独立的 delete scope', () => {
  let t: TestServer;

  beforeEach(async () => {
    t = await createTestServer();
  });
  afterEach(() => t.cleanup());

  /** 单分片上传 1 MiB，返回 fileId。 */
  async function uploadFile(apiKey: string): Promise<string> {
    const size = 1024 * 1024;
    const buf = randomBytes(size);
    const sha256 = createHash('sha256').update(buf).digest('hex');

    const init = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', apiKey)
      .send({ filename: 'a.bin', totalSize: size, chunkSize: size });
    expect(init.status).toBe(201);
    const uploadId = init.body.uploadId as string;

    const put = await t.request
      .put(`/v1/storage/uploads/${uploadId}/chunks/0`)
      .set('X-API-Key', apiKey)
      .set('Content-Type', 'application/octet-stream')
      .send(buf);
    expect(put.status).toBe(200);

    const done = await t.request
      .post(`/v1/storage/uploads/${uploadId}/complete`)
      .set('X-API-Key', apiKey)
      .send({ sha256 });
    expect(done.status).toBe(200);
    return done.body.fileId as string;
  }

  /** 建一个只带指定 scope 的应用 + Key。 */
  async function setup(slug: string, scopes: string[]): Promise<{ appId: string; key: string }> {
    const app = await createApp(t.request, t.masterKey, slug);
    return { appId: app.id, key: await issueKey(t.request, t.masterKey, { appId: app.id, scopes }) };
  }

  it('① 只有 storage:write 的 Key 删不掉文件', async () => {
    const { key } = await setup('del-storage-rw', ['storage:read', 'storage:write']);
    const fileId = await uploadFile(key);

    const res = await t.request.delete(`/v1/storage/files/${fileId}`).set('X-API-Key', key);
    expect(res.status).toBe(403);
    // SCOPE_DENIED 而不是笼统的 FORBIDDEN：客户端要能据此提示「权限不够」而非「被封了」
    expect(res.body.error.code).toBe('SCOPE_DENIED');

    // 文件必须还在 —— 403 只是「没权限」，不是「删了但报错」
    const meta = await t.request.get(`/v1/storage/files/${fileId}`).set('X-API-Key', key);
    expect(meta.status).toBe(200);
  });

  it('② 带 storage:delete 的 Key 能删文件', async () => {
    const { key } = await setup('del-storage-del', ['storage:read', 'storage:write', 'storage:delete']);
    const fileId = await uploadFile(key);

    const res = await t.request.delete(`/v1/storage/files/${fileId}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
  });

  it('③ 迁移通道：给老 Key 补 storage:delete 后，同一把 Key 就能删（不用重签）', async () => {
    const { appId, key } = await setup('del-migrate', ['storage:read', 'storage:write']);
    const fileId = await uploadFile(key);

    // 升级前：写权限删不掉
    const before = await t.request.delete(`/v1/storage/files/${fileId}`).set('X-API-Key', key);
    expect(before.status).toBe(403);

    // 找到这把 Key 并补权限（Master 通道）
    const listed = await t.request.get('/v1/keys').set('X-Master-Key', t.masterKey);
    const row = (listed.body as Array<{ id: string; appId: string; revokedAt: number | null }>).find(
      (k) => k.appId === appId,
    )!;
    const patched = await t.request
      .patch(`/v1/keys/${row.id}`)
      .set('X-Master-Key', t.masterKey)
      .send({ scopes: ['storage:read', 'storage:write', 'storage:delete'] });
    expect(patched.status).toBe(200);
    expect(patched.body.scopes).toContain('storage:delete');
    // 明文不受影响：改权限不该动到 Key 本身
    expect(patched.body.key).toBeUndefined();

    // 升级后：还是原来那把 Key，现在能删了
    const after = await t.request.delete(`/v1/storage/files/${fileId}`).set('X-API-Key', key);
    expect(after.status).toBe(200);
  });

  it('④ 只有 release:write 的 Key 下架不了版本', async () => {
    const { key } = await setup('del-rel-rw', ['storage:read', 'storage:write', 'release:read', 'release:write']);
    const fileId = await uploadFile(key);
    const created = await t.request
      .post('/v1/releases')
      .set('X-API-Key', key)
      .send({ channel: 'stable', platform: 'win', arch: 'x64', version: '1.0.0', fileId, published: true });
    expect(created.status).toBe(201);

    const res = await t.request.delete(`/v1/releases/${created.body.id}`).set('X-API-Key', key);
    expect(res.status).toBe(403);

    // 版本仍在 latest 里
    const latest = await t.request
      .get('/v1/releases/latest')
      .query({ platform: 'win', arch: 'x64', channel: 'stable' })
      .set('X-API-Key', key);
    expect(latest.body.version).toBe('1.0.0');
  });

  it('⑤ 带 release:delete 的 Key 能下架版本', async () => {
    const { key } = await setup('del-rel-del', [
      'storage:read',
      'storage:write',
      'release:read',
      'release:write',
      'release:delete',
    ]);
    const fileId = await uploadFile(key);
    const created = await t.request
      .post('/v1/releases')
      .set('X-API-Key', key)
      .send({ channel: 'stable', platform: 'win', arch: 'x64', version: '2.0.0', fileId, published: true });

    const res = await t.request.delete(`/v1/releases/${created.body.id}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
  });

  it('⑥ 只有 announcements:write 的 Key 删不掉公告', async () => {
    const { key } = await setup('del-ann-rw', ['announcements:read', 'announcements:write']);
    const created = await t.request
      .post('/v1/announcements')
      .set('X-API-Key', key)
      .send({ title: '要删的', contentMd: 'x' });

    const res = await t.request.delete(`/v1/announcements/${created.body.id}`).set('X-API-Key', key);
    expect(res.status).toBe(403);
  });

  it('⑦ 带 announcements:delete 的 Key 能删公告', async () => {
    const { key } = await setup('del-ann-del', ['announcements:read', 'announcements:write', 'announcements:delete']);
    const created = await t.request
      .post('/v1/announcements')
      .set('X-API-Key', key)
      .send({ title: '要删的', contentMd: 'x' });

    const res = await t.request.delete(`/v1/announcements/${created.body.id}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
  });

  it('⑧ 放弃上传仍只需 storage:write —— 上传流程的取消动作不算删数据', async () => {
    const { key } = await setup('del-abort', ['storage:read', 'storage:write']);
    const init = await t.request
      .post('/v1/storage/uploads')
      .set('X-API-Key', key)
      .send({ filename: 'b.bin', totalSize: 1024 * 1024, chunkSize: 1024 * 1024 });

    const res = await t.request.delete(`/v1/storage/uploads/${init.body.uploadId}`).set('X-API-Key', key);
    expect(res.status).toBe(200);
  });

  it('⑨ PATCH 拒绝未知 scope', async () => {
    const { appId } = await setup('del-bad', ['storage:read']);
    const listed = await t.request.get('/v1/keys').set('X-Master-Key', t.masterKey);
    const row = (listed.body as Array<{ id: string; appId: string }>).find((k) => k.appId === appId)!;

    const res = await t.request
      .patch(`/v1/keys/${row.id}`)
      .set('X-Master-Key', t.masterKey)
      .send({ scopes: ['storage:read', 'storage:nuke'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('⑩ PATCH 已吊销的 Key → 409', async () => {
    const { appId } = await setup('del-revoked', ['storage:read']);
    const listed = await t.request.get('/v1/keys').set('X-Master-Key', t.masterKey);
    const row = (listed.body as Array<{ id: string; appId: string }>).find((k) => k.appId === appId)!;
    await t.request.delete(`/v1/keys/${row.id}`).set('X-Master-Key', t.masterKey);

    const res = await t.request
      .patch(`/v1/keys/${row.id}`)
      .set('X-Master-Key', t.masterKey)
      .send({ scopes: ['storage:read', 'storage:delete'] });
    expect(res.status).toBe(409);
  });

  it('⑪ PATCH 不认 APIKey —— 没有 Master 头就是「未认证」，不是「权限不够」', async () => {
    const { appId, key } = await setup('del-master-only', ['storage:read', 'admin:*']);
    const listed = await t.request.get('/v1/keys').set('X-Master-Key', t.masterKey);
    const row = (listed.body as Array<{ id: string; appId: string }>).find((k) => k.appId === appId)!;

    const res = await t.request
      .patch(`/v1/keys/${row.id}`)
      .set('X-API-Key', key)
      .send({ scopes: ['storage:read', 'storage:delete', 'admin:*'] });
    // 401：改权限属于管理面，哪怕手握 admin:* 的 APIKey 也不行 —— 只认 Master Key
    expect(res.status).toBe(401);
  });
});
