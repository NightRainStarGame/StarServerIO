import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

/**
 * 限流按「应用 / Key」分桶，而不是只按 IP。
 * 下面验证：同一 Key 连打超限会被 429，且换一把 Key 立刻恢复（说明桶是按 Key 分的）。
 */
describe('限流', () => {
  let t: TestServer;

  beforeEach(async () => {
    t = await createTestServer({ RATE_LIMIT_MAX: '50' });
  });
  afterEach(() => t.cleanup());

  it('连打 200 次 → 出现 429 RATE_LIMITED', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 200; i++) {
      const res = await t.request.get('/v1/healthz');
      lastStatus = res.status;
      if (res.status === 429) {
        expect(res.body.error.code).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(lastStatus).toBe(429);
  });

  it('限流按 APIKey 分桶：A 被限住时 B 仍可用', async () => {
    const app = await createApp(t.request, t.masterKey, 'demo');
    const keyA = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['release:read'] });
    const keyB = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['users:read'] });

    // A 只带 release:read，取不到用户接口，但足以触发鉴权与限流
    let got429 = false;
    for (let i = 0; i < 60; i++) {
      const res = await t.request.get('/v1/users/x').set('X-API-Key', keyA);
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);

    // 换一把 Key：不同桶，应当仍能正常鉴权（404 表示过了限流关）
    const other = await t.request.get('/v1/users/x').set('X-API-Key', keyB);
    expect(other.status).toBe(404);
  });
});
