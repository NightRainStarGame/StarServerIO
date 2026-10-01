import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';

/**
 * 论坛（P3）：权限划分是本模块的核心，测试重点放在「谁能做什么」上。
 */

let t: TestServer;
let appId: string;
let adminKey: string;
let aliceToken: string;
let bobToken: string;
let threadId: string;

const SLUG = 'general';

async function registerUser(username: string): Promise<string> {
  const res = await t.request
    .post('/v1/auth/register')
    .set('X-API-Key', adminKey)
    .send({ username, password: 'password123' });
  return res.body.accessToken as string;
}

beforeAll(async () => {
  t = await createTestServer();
  const app = await createApp(t.request, t.masterKey, 'forum-app');
  appId = app.id;
  adminKey = await issueKey(t.request, t.masterKey, { appId, scopes: ['forum:read', 'forum:write', 'auth:read'] });
  aliceToken = await registerUser('alice');
  bobToken = await registerUser('bob');

  const board = await t.request
    .post('/v1/forum/boards')
    .set('X-API-Key', adminKey)
    .send({ slug: SLUG, name: '综合讨论' });
  expect(board.status).toBe(201);
}, 30_000);

afterAll(() => t.cleanup());

describe('论坛', () => {
  it('发帖必须是用户身份：APIKey 单独发帖被拒', async () => {
    const res = await t.request
      .post(`/v1/forum/boards/${SLUG}/threads`)
      .set('X-API-Key', adminKey)
      .send({ title: '应用代发', contentMd: 'hello' });
    expect(res.status).toBe(401);
  });

  it('未认证读板块 → 401', async () => {
    const res = await t.request.get('/v1/forum/boards');
    expect(res.status).toBe(401);
  });

  it('用户发帖成功，板块计数自增', async () => {
    const res = await t.request
      .post(`/v1/forum/boards/${SLUG}/threads`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ title: '第一个帖子', contentMd: '正文' });
    expect(res.status).toBe(201);
    threadId = res.body.id as string;

    const boards = await t.request.get('/v1/forum/boards').set('X-API-Key', adminKey);
    expect(boards.status).toBe(200);
    expect((boards.body as Array<{ threadCount: number }>)[0]!.threadCount).toBe(1);
  });

  it('回复楼层连续，按楼层号正序返回', async () => {
    const p1 = await t.request
      .post(`/v1/forum/threads/${threadId}/posts`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ contentMd: '沙发' });
    expect(p1.status).toBe(201);
    expect(p1.body.floor).toBe(1);

    const p2 = await t.request
      .post(`/v1/forum/threads/${threadId}/posts`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ contentMd: '板凳' });
    expect(p2.body.floor).toBe(2);

    const list = await t.request.get(`/v1/forum/threads/${threadId}/posts`).set('X-API-Key', adminKey);
    const posts = list.body as Array<{ floor: number; contentMd: string }>;
    expect(posts.map((p) => p.floor)).toEqual([1, 2]);
    expect(posts[0]!.contentMd).toBe('沙发');

    // 帖子详情的 replyCount 与浏览量都随回复推进
    const detail = await t.request.get(`/v1/forum/threads/${threadId}`).set('X-API-Key', adminKey);
    expect(detail.body.replyCount).toBe(2);
    expect(detail.body.viewCount).toBe(1);
  });

  it('锁帖后禁止回复，但内容仍可读', async () => {
    const lock = await t.request
      .patch(`/v1/forum/threads/${threadId}`)
      .set('X-API-Key', adminKey)
      .send({ locked: true });
    expect(lock.status).toBe(200);

    const res = await t.request
      .post(`/v1/forum/threads/${threadId}/posts`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ contentMd: '还想回' });
    expect(res.status).toBe(403);

    const detail = await t.request.get(`/v1/forum/threads/${threadId}`).set('X-API-Key', adminKey);
    expect(detail.status).toBe(200);
  });

  it('置顶帖排在列表最前', async () => {
    const second = await t.request
      .post(`/v1/forum/boards/${SLUG}/threads`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ title: '第二个帖子', contentMd: '正文2' });
    const secondId = second.body.id as string;

    // 默认顺序：最新回复在前，第二个帖子刚发所以靠前
    const before = (await t.request.get(`/v1/forum/boards/${SLUG}/threads`).set('X-API-Key', adminKey)).body as Array<{
      id: string;
    }>;
    expect(before[0]!.id).toBe(secondId);

    await t.request.patch(`/v1/forum/threads/${threadId}`).set('X-API-Key', adminKey).send({ pinned: true });

    const after = (await t.request.get(`/v1/forum/boards/${SLUG}/threads`).set('X-API-Key', adminKey)).body as Array<{
      id: string;
    }>;
    expect(after[0]!.id).toBe(threadId);
  });

  it('跨应用隔离：别的应用的 Key 看不到本应用板块', async () => {
    const other = await createApp(t.request, t.masterKey, 'forum-other');
    const otherKey = await issueKey(t.request, t.masterKey, { appId: other.id, scopes: ['forum:read'] });

    const boards = await t.request.get('/v1/forum/boards').set('X-API-Key', otherKey);
    expect(boards.status).toBe(200);
    expect((boards.body as unknown[]).length).toBe(0);

    const threads = await t.request.get(`/v1/forum/boards/${SLUG}/threads`).set('X-API-Key', otherKey);
    expect(threads.status).toBe(404);
  });

  it('板块 slug 重复 → 409', async () => {
    const dup = await t.request
      .post('/v1/forum/boards')
      .set('X-API-Key', adminKey)
      .send({ slug: SLUG, name: '重复' });
    expect(dup.status).toBe(409);
  });
});
