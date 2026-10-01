import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_KEY_PREFIX } from '../src/lib/keys.js';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

describe('应用（租户）CRUD', () => {
  let t: TestServer;

  beforeEach(async () => {
    t = await createTestServer();
  });
  afterEach(() => t.cleanup());

  it('创建 / 列表 / 详情', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo', 'Demo App');
    expect(app.slug).toBe('demo');

    const list = await t.request.get('/v1/apps').set('X-Master-Key', t.masterKey);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const detail = await t.request.get(`/v1/apps/${app.id}`).set('X-Master-Key', t.masterKey);
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe('Demo App');
  });

  it('没有 Master Key → 401', async () => {
    const res = await t.request.post('/v1/apps').send({ slug: 'demo', name: 'Demo' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('错误的 Master Key → 401', async () => {
    const res = await t.request.post('/v1/apps').set('X-Master-Key', 'wrong-master-key-value').send({ slug: 'demo', name: 'Demo' });
    expect(res.status).toBe(401);
  });

  it('重复 slug → 409 CONFLICT', async () => {
    await createApp(t.request, t.masterKey, 'demo');
    const res = await t.request.post('/v1/apps').set('X-Master-Key', t.masterKey).send({ slug: 'demo', name: 'Another' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('普通 APIKey 无权创建应用（租户隔离的第一道闸）', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const key = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['admin:*'] });

    const res = await t.request.post('/v1/apps').set('X-API-Key', key).send({ slug: 'evil', name: 'Evil' });
    expect(res.status).toBe(401);
  });

  it('删除应用会级联清掉它的 Key 与用户，不留可登录的孤儿凭据', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['release:read'] });
    await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['auth:read'] }))
      .send({ username: 'alice', password: 'password123' });

    const del = await t.request.delete(`/v1/apps/${app.id}`).set('X-Master-Key', t.masterKey);
    expect(del.status).toBe(200);

    const rows = t.sqlite.prepare('SELECT (SELECT COUNT(*) FROM api_keys) AS k, (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM refresh_tokens) AS r').get() as {
      k: number;
      u: number;
      r: number;
    };
    expect(rows).toEqual({ k: 0, u: 0, r: 0 });
  });

  it('签发的 Key 形如 ssio_live_<22位>', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const key = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['release:read'] });
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 22);
    expect(key.slice(API_KEY_PREFIX.length)).toMatch(/^[0-9a-zA-Z]{22}$/);
  });
});
