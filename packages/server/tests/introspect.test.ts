import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntrospectResult } from '@ssio/shared';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

/**
 * `/v1/auth/introspect` 是 SSIO 作为「被调方」的关键契约：
 * 业务后端拿自己 app 的 APIKey 来校验它收到的用户 JWT。
 */
describe('POST /v1/auth/introspect', () => {
  let t: TestServer;
  let appAId: string;
  let keyA: string;

  beforeEach(async () => {
    t = await createTestServer();
    const appA = await createApp(t.request, t.masterKey, 'app-a');
    appAId = appA.id;
    keyA = await issueKey(t.request, t.masterKey, { appId: appA.id, scopes: ['auth:read'] });
  });
  afterEach(() => t.cleanup());

  const registerUser = async (key: string, username: string) => {
    const res = await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', key)
      .send({ username, password: 'password123' });
    return res.body.accessToken as string;
  };

  it('有效 token → valid:true 并返回用户摘要', async () => {
    const token = await registerUser(keyA, 'alice');
    const res = await t.request.post('/v1/auth/introspect').set('X-API-Key', keyA).send({ token });
    expect(res.status).toBe(200);
    const body = res.body as IntrospectResult;
    expect(body.valid).toBe(true);
    expect(body.appId).toBe(appAId);
    expect(body.nickname).toBe('alice');
    expect(body.status).toBe('active');
    expect(typeof body.exp).toBe('number');
  });

  it('无效 / 被篡改的 token → valid:false，且不抛 401（便于业务方分支）', async () => {
    const res = await t.request.post('/v1/auth/introspect').set('X-API-Key', keyA).send({ token: 'not-a-jwt' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('跨应用的 token → valid:false', async () => {
    const token = await registerUser(keyA, 'alice');
    const appB = await createApp(t.request, t.masterKey, 'app-b');
    const keyB = await issueKey(t.request, t.masterKey, { appId: appB.id, scopes: ['auth:read'] });

    const res = await t.request.post('/v1/auth/introspect').set('X-API-Key', keyB).send({ token });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('需要 auth:read scope', async () => {
    const noScope = await issueKey(t.request, t.masterKey, { appId: appAId, scopes: ['release:read'] });
    const res = await t.request.post('/v1/auth/introspect').set('X-API-Key', noScope).send({ token: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCOPE_DENIED');
  });
});
