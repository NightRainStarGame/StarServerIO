import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

describe('APIKey 鉴权', () => {
  let t: TestServer;

  beforeEach(async () => {
    t = await createTestServer();
  });
  afterEach(() => t.cleanup());

  /** `/v1/auth/register` 需要 APIKey 但不需要 admin scope，是验证 Key 通道最省事的目标。 */
  const registerWith = (key?: string) => {
    const req = t.request.post('/v1/auth/register').send({ username: 'alice', password: 'password123' });
    return key ? req.set('X-API-Key', key) : req;
  };

  it('① 无 APIKey → 401 UNAUTHORIZED', async () => {
    const res = await registerWith();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('② 错误 APIKey → 401 UNAUTHORIZED', async () => {
    const res = await registerWith('ssio_live_totallymadeupkey00000');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('③ 已吊销 APIKey → 401 KEY_REVOKED', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const key = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['auth:read'] });

    const listed = await t.request.get('/v1/keys').set('X-Master-Key', t.masterKey);
    const keyId = (listed.body as Array<{ id: string }>)[0]!.id;
    const revoked = await t.request.delete(`/v1/keys/${keyId}`).set('X-Master-Key', t.masterKey);
    expect(revoked.status).toBe(200);

    const res = await registerWith(key);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('KEY_REVOKED');
  });

  it('④ 已过期 APIKey → 401 KEY_EXPIRED', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const key = await issueKey(t.request, t.masterKey, {
      appId: app.id,
      scopes: ['auth:read'],
      expiresAt: Date.now() - 1000,
    });

    const res = await registerWith(key);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('KEY_EXPIRED');
  });

  it('⑤ scope 不足 → 403 SCOPE_DENIED', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const readOnly = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['release:read'] });

    // /v1/users/:id 需要 users:read
    const res = await t.request.get('/v1/users/whatever').set('X-API-Key', readOnly);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCOPE_DENIED');
    expect(res.body.error.details.required).toEqual(['users:read']);
  });

  it('⑥ 拥有 admin:* 的 Key 可以绕过具体 scope 校验', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const adminKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['admin:*'] });
    const res = await t.request.get('/v1/users/whatever').set('X-API-Key', adminKey);
    // 过了 scope 这一关，落到 404（用户不存在）
    expect(res.status).toBe(404);
  });

  it('⑦ 明文只在签发响应出现一次，数据库里只有 sha256', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const key = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['release:read'] });

    const rows = t.sqlite.prepare('SELECT * FROM api_keys').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    const expectedHash = createHash('sha256').update(key).digest('hex');
    expect(row.key_hash).toBe(expectedHash);
    expect(row.key_hash).not.toBe(key);

    // 遍历所有列，确保没有任何一列存了明文
    for (const [col, value] of Object.entries(row)) {
      expect(String(value), `列 ${col} 不应出现明文`).not.toBe(key);
      expect(String(value)).not.toContain(key);
    }

    // 列表接口只返回前缀与掩码，不含明文
    const listed = await t.request.get('/v1/keys').set('X-Master-Key', t.masterKey);
    expect(JSON.stringify(listed.body)).not.toContain(key);
    expect((listed.body as Array<{ masked: string }>)[0]!.masked).toContain('*');
  });

  it('⑧ 未知 scope 无法签发（防拼写错误导致的权限空洞）', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const res = await t.request
      .post('/v1/keys')
      .set('X-Master-Key', t.masterKey)
      .send({ appId: app.id, name: 'bad', scopes: ['release:reed'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
