import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { createApp, createTestServer, issueKey } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('公告', () => {
  let t: TestServer;
  let apiKey: string;

  beforeAll(async () => {
    t = await createTestServer();
    const app = await createApp(t.request, t.masterKey, 'news-app');
    apiKey = await issueKey(t.request, t.masterKey, {
      appId: app.id,
      scopes: ['announcements:read', 'announcements:write'],
    });
  });

  afterAll(() => t.cleanup());

  it('未开始的公告不出现在 /active', async () => {
    await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: '未来公告', contentMd: '还没开始', startAt: Date.now() + DAY });
    const active = await t.request.get('/v1/announcements/active').set('X-API-Key', apiKey);
    expect(active.status).toBe(200);
    expect((active.body as Array<{ title: string }>).map((a) => a.title)).not.toContain('未来公告');
  });

  it('已结束的公告不出现在 /active', async () => {
    await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: '过期公告', contentMd: '已经结束', startAt: Date.now() - 2 * DAY, endAt: Date.now() - DAY });
    const active = await t.request.get('/v1/announcements/active').set('X-API-Key', apiKey);
    expect((active.body as Array<{ title: string }>).map((a) => a.title)).not.toContain('过期公告');
  });

  it('生效中的公告按「置顶优先、新的在前」排序', async () => {
    const now = Date.now();
    await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: '普通新', contentMd: 'a', startAt: now + 1000 });
    await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: '普通旧', contentMd: 'b', startAt: now });
    await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: '置顶', contentMd: 'c', pinned: true, startAt: now - 1000, level: 'urgent' });

    const active = await t.request.get('/v1/announcements/active').set('X-API-Key', apiKey);
    const titles = (active.body as Array<{ title: string }>).map((a) => a.title);
    expect(titles[0]).toBe('置顶');
    expect(titles.indexOf('普通新')).toBeLessThan(titles.indexOf('普通旧'));
  });

  it('endAt 早于 startAt → 400', async () => {
    const res = await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: 'x', contentMd: 'y', startAt: Date.now(), endAt: Date.now() - 1000 });
    expect(res.status).toBe(400);
  });

  it('列表接口返回全部公告（含未生效的）', async () => {
    const all = await t.request.get('/v1/announcements').set('X-API-Key', apiKey);
    expect((all.body as Array<unknown>).length).toBeGreaterThanOrEqual(5);
  });

  it('PATCH / DELETE 生效', async () => {
    const created = await t.request
      .post('/v1/announcements')
      .set('X-API-Key', apiKey)
      .send({ title: '可改', contentMd: '旧内容' });
    const id = created.body.id as string;

    const patched = await t.request
      .patch(`/v1/announcements/${id}`)
      .set('X-API-Key', apiKey)
      .send({ pinned: true, level: 'warning' });
    expect(patched.status).toBe(200);
    expect(patched.body.pinned).toBe(true);
    expect(patched.body.level).toBe('warning');

    const del = await t.request.delete(`/v1/announcements/${id}`).set('X-API-Key', apiKey);
    expect(del.status).toBe(200);
    const after = await t.request.get(`/v1/announcements`).set('X-API-Key', apiKey);
    expect((after.body as Array<{ id: string }>).map((a) => a.id)).not.toContain(id);
  });

  it('缺少 announcements:write 的 Key 不能发公告', async () => {
    const app = await createApp(t.request, t.masterKey, 'news-app2');
    const ro = await issueKey(t.request, t.masterKey, { appId: app.id, scopes: ['announcements:read'] });
    const res = await t.request.post('/v1/announcements').set('X-API-Key', ro).send({ title: 'x', contentMd: 'y' });
    expect(res.status).toBe(403);
  });
});
