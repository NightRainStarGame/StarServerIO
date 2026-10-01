import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthTokens, UserSelf } from '@ssio/shared';
import { cleanupRefreshTokens } from '../src/modules/auth.js';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

describe('用户认证链路', () => {
  let t: TestServer;
  let apiKey: string;
  let appId: string;

  beforeEach(async () => {
    t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'demo');
    appId = app.id;
    apiKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['auth:read', 'users:read'] });
  });
  afterEach(() => t.cleanup());

  it('注册 → 登录 → me → refresh（旧的失效）→ logout', async () => {
    const reg = await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', apiKey)
      .send({ username: 'alice', password: 'password123', nickname: '爱丽丝' });
    expect(reg.status).toBe(201);
    const first = reg.body as AuthTokens & { user: UserSelf };
    expect(first.user.nickname).toBe('爱丽丝');
    expect(first.accessToken).toBeTruthy();
    expect(first.refreshToken).toBeTruthy();

    const login = await t.request
      .post('/v1/auth/login')
      .set('X-API-Key', apiKey)
      .send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);
    const tokens = login.body as AuthTokens & { user: UserSelf };

    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('alice');
    // me 对本人可见邮箱/手机
    expect(me.body.email).toBeNull();

    const rotated = await t.request
      .post('/v1/auth/refresh')
      .set('X-API-Key', apiKey)
      .send({ refreshToken: tokens.refreshToken });
    expect(rotated.status).toBe(200);
    // access token 没有 jti，同一秒内两次签发会字节相同（设计如此：短效 + 不可单独吊销），
    // 因此这里断言 refresh token 一定轮换出新值
    expect((rotated.body as AuthTokens).refreshToken).not.toBe(tokens.refreshToken);

    // 轮换后旧 refresh token 立即失效（防重放）
    const replay = await t.request
      .post('/v1/auth/refresh')
      .set('X-API-Key', apiKey)
      .send({ refreshToken: tokens.refreshToken });
    expect(replay.status).toBe(401);

    const out = await t.request
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${(rotated.body as AuthTokens).accessToken}`)
      .send({ refreshToken: (rotated.body as AuthTokens).refreshToken });
    expect(out.status).toBe(200);
    expect(out.body.revoked).toBe(1);
  });

  it('重复用户名 → 409 CONFLICT', async () => {
    await t.request.post('/v1/auth/register').set('X-API-Key', apiKey).send({ username: 'alice', password: 'password123' });
    const dup = await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', apiKey)
      .send({ username: 'alice', password: 'password456' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('密码错误 → 401，且与「用户不存在」返回同一个错误码（防账号枚举）', async () => {
    await t.request.post('/v1/auth/register').set('X-API-Key', apiKey).send({ username: 'alice', password: 'password123' });

    const wrongPwd = await t.request
      .post('/v1/auth/login')
      .set('X-API-Key', apiKey)
      .send({ username: 'alice', password: 'wrongpassword' });
    expect(wrongPwd.status).toBe(401);
    expect(wrongPwd.body.error.code).toBe('UNAUTHORIZED');

    const noUser = await t.request
      .post('/v1/auth/login')
      .set('X-API-Key', apiKey)
      .send({ username: 'ghost', password: 'password123' });
    expect(noUser.status).toBe(401);
    expect(noUser.body.error.code).toBe(wrongPwd.body.error.code);
  });

  it('弱密码 / 非法用户名 → 400 VALIDATION', async () => {
    const weak = await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', apiKey)
      .send({ username: 'alice', password: '123' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION');

    const badName = await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', apiKey)
      .send({ username: 'a b', password: 'password123' });
    expect(badName.status).toBe(400);
  });

  it('跨应用隔离：用 B 应用的 Key 查 A 应用的用户 → 404', async () => {
    await t.request.post('/v1/auth/register').set('X-API-Key', apiKey).send({ username: 'alice', password: 'password123' });

    const listed = await t.request.get('/v1/users/x').set('X-API-Key', apiKey);
    expect(listed.status).toBe(404);

    const appB = await createApp(t.request, t.masterKey, 'other');
    const keyB = await issueKey(t.request, t.masterKey, { appId: appB.id, scopes: ['users:read'] });
    const users = t.sqlite.prepare('SELECT id FROM users WHERE app_id = ?').all(appId) as Array<{ id: string }>;
    const aliceId = users[0]!.id;

    const res = await t.request.get(`/v1/users/${aliceId}`).set('X-API-Key', keyB);
    expect(res.status).toBe(404);
  });

  it('/v1/users/:id 不返回手机号与邮箱', async () => {
    await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', apiKey)
      .send({ username: 'alice', password: 'password123', email: 'a@example.com', phone: '13800000000' });

    const users = t.sqlite.prepare('SELECT id FROM users WHERE app_id = ?').all(appId) as Array<{ id: string }>;
    const res = await t.request.get(`/v1/users/${users[0]!.id}`).set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('email');
    expect(res.body).not.toHaveProperty('phone');
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('无 JWT 访问 /v1/auth/me → 401', async () => {
    const res = await t.request.get('/v1/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('过期 refresh token 清理', () => {
  it('过期与久置已吊销的行被删，30 天内吊销的保留', async () => {
    const t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'token-gc');
    const apiKey = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['auth:read'] });

    // 造三条：过期未吊销 / 刚吊销（应保留）/ 吊销超 30 天（应删）
    await t.request
      .post('/v1/auth/register')
      .set('X-API-Key', apiKey)
      .send({ username: 'gc1', password: 'password123' });
    await t.request.post('/v1/auth/register').set('X-API-Key', apiKey).send({ username: 'gc2', password: 'password123' });
    await t.request.post('/v1/auth/register').set('X-API-Key', apiKey).send({ username: 'gc3', password: 'password123' });
    const ids = (t.sqlite.prepare('SELECT id FROM refresh_tokens').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toHaveLength(3);

    const now = Date.now();
    const notExpired = now + 30 * 24 * 3600 * 1000;
    // gc1：已过期未吊销 → 删
    t.sqlite.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE id = ?').run(now - 1000, ids[0]!);
    // gc2：未过期、刚吊销 → 保留（30 天内吊销的供排查）
    t.sqlite.prepare('UPDATE refresh_tokens SET expires_at = ?, revoked_at = ? WHERE id = ?').run(notExpired, now - 1000, ids[1]!);
    // gc3：未过期、吊销超 30 天 → 删
    t.sqlite
      .prepare('UPDATE refresh_tokens SET expires_at = ?, revoked_at = ? WHERE id = ?')
      .run(notExpired, now - 31 * 24 * 3600 * 1000, ids[2]!);

    const deleted = cleanupRefreshTokens(t.db);
    expect(deleted).toBe(2);

    const left = t.sqlite.prepare('SELECT id FROM refresh_tokens').all() as Array<{ id: string }>;
    expect(left.map((r) => r.id)).toEqual([ids[1]]);
    t.cleanup();
  });
});
