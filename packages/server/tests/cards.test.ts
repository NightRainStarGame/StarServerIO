import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { createApp, createTestServer, issueKey } from './helpers.js';

async function createBatch(
  t: TestServer,
  appId: string,
  body: { name: string; total: number; codeLength?: number; prefix?: string; payload?: Record<string, unknown> },
) {
  return t.request.post('/v1/cards/batches').set('X-Master-Key', t.masterKey).query({ appId }).send(body);
}

describe('发卡', () => {
  let t: TestServer;
  let appId: string;
  let redeemKey: string;

  beforeAll(async () => {
    t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'card-app');
    appId = app.id;
    redeemKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['cards:redeem'] });
  });

  afterAll(() => t.cleanup());

  it('生成 10000 张耗时 < 5 秒', async () => {
    const res = await createBatch(t, appId, { name: 'promo', total: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.generatedCount).toBe(10000);

    const elapsed = res.body.generatedInMs as number;
    // eslint-disable-next-line no-console
    console.log(`[bench] 生成 10000 张卡密（含落库）: ${elapsed} ms`);
    expect(elapsed).toBeLessThan(5000);
  }, 60_000);

  it('导出链接可下载明文 CSV，且不可二次获取', async () => {
    const batch = await createBatch(t, appId, { name: 'exportable', total: 5 });
    const exportUrl = batch.body.exportUrl as string;

    const first = await t.request.get(exportUrl);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('text/csv');
    const lines = (first.text as string).trim().split('\n');
    // 首行是表头，后面每行一个明文卡密
    expect(lines[0]).toBe('code');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const second = await t.request.get(exportUrl);
    expect(second.status).toBe(409);

    // 取一个明文去核销，验证导出的码真的可用
    const code = lines[1]!;
    const redeem = await t.request.post('/v1/cards/redeem').set('X-API-Key', redeemKey).send({ code });
    expect(redeem.status).toBe(200);
    expect(redeem.body.redeemed).toBe(true);
  });

  it('篡改导出签名 → 401', async () => {
    const batch = await createBatch(t, appId, { name: 'signed', total: 3 });
    const url = batch.body.exportUrl as string;
    const tampered = url.replace(/sig=(.)/, (_, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`);
    const res = await t.request.get(tampered);
    expect(res.status).toBe(401);
  });

  it('核销幂等：重复核销返回首次时间，不报错', async () => {
    const batch = await createBatch(t, appId, { name: 'idem', total: 2, payload: { days: 30 } });
    const csv = await t.request.get(batch.body.exportUrl as string);
    const code = (csv.text as string).trim().split('\n')[1]!;

    const first = await t.request.post('/v1/cards/redeem').set('X-API-Key', redeemKey).send({ code });
    expect(first.body.redeemed).toBe(true);
    expect(first.body.status).toBe('used');
    expect(first.body.payload).toEqual({ days: 30 });

    const again = await t.request.post('/v1/cards/redeem').set('X-API-Key', redeemKey).send({ code });
    expect(again.status).toBe(200);
    expect(again.body.redeemed).toBe(false);
    expect(again.body.usedAt).toBe(first.body.usedAt);
  });

  it('并发 50 次核销同一码 → 恰好 1 个首次成功，49 个幂等', async () => {
    const batch = await createBatch(t, appId, { name: 'race', total: 1 });
    const csv = await t.request.get(batch.body.exportUrl as string);
    const code = (csv.text as string).trim().split('\n')[1]!;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => t.request.post('/v1/cards/redeem').set('X-API-Key', redeemKey).send({ code })),
    );
    const claimed = results.filter((r) => r.body.redeemed === true);
    const idempotent = results.filter((r) => r.body.redeemed === false);
    expect(claimed).toHaveLength(1);
    expect(idempotent).toHaveLength(49);
    // 所有响应看到的首次核销时间必须一致
    const usedAt = new Set(results.map((r) => r.body.usedAt));
    expect(usedAt.size).toBe(1);
  });

  it('不存在的卡密 → 404；卡密大小写与分隔符不敏感', async () => {
    const missing = await t.request.post('/v1/cards/redeem').set('X-API-Key', redeemKey).send({ code: 'ZZZZ-ZZZZ-ZZZZ' });
    expect(missing.status).toBe(404);

    const batch = await createBatch(t, appId, { name: 'case', total: 1 });
    const csv = await t.request.get(batch.body.exportUrl as string);
    const code = (csv.text as string).trim().split('\n')[1]!;
    const lower = code.toLowerCase().replace(/-/g, '');
    const res = await t.request.post('/v1/cards/redeem').set('X-API-Key', redeemKey).send({ code: lower });
    expect(res.status).toBe(200);
    expect(res.body.redeemed).toBe(true);
  });

  it('普通业务 Key 无权生成卡密', async () => {
    const bizKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['cards:redeem', 'storage:read'] });
    const res = await t.request.post('/v1/cards/batches').set('X-API-Key', bizKey).send({ name: 'x', total: 1 });
    expect(res.status).toBe(403);
  });

  it('数据库里不存明文卡密', async () => {
    const batch = await createBatch(t, appId, { name: 'nostore', total: 3 });
    const csv = await t.request.get(batch.body.exportUrl as string);
    const code = (csv.text as string).trim().split('\n')[1]!;

    const found = t.sqlite.prepare('SELECT COUNT(*) AS n FROM cards WHERE code_hash = ?').get(code) as { n: number };
    expect(found.n).toBe(0);
    const byPlain = t.sqlite.prepare('SELECT COUNT(*) AS n FROM cards WHERE code_mask = ?').get(code) as { n: number };
    expect(byPlain.n).toBe(0);
  });
});
