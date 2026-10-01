import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServer } from './helpers.js';

describe('健康检查', () => {
  let t: TestServer;

  beforeEach(async () => {
    t = await createTestServer();
  });
  afterEach(() => t.cleanup());

  it('/v1/healthz 不鉴权直接返回', async () => {
    const res = await t.request.get('/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('/v1/readyz 查一次数据库', async () => {
    const res = await t.request.get('/v1/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true });
  });

  it('请求体不是合法 JSON → 400 BAD_REQUEST（不能伪装成 500）', async () => {
    const res = await t.request
      .post('/v1/apps')
      .set('Content-Type', 'application/json')
      .send('{ not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('未知路由返回统一 NOT_FOUND 结构', async () => {
    const res = await t.request.get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
