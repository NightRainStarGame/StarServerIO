import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createTestServer, issueKey, type TestServer } from './helpers.js';
// embedded 的限流桶键是 `IP:slug`，跨用例不变 —— 必须显式复位，否则后面的用例会被前面用例的计数误伤
import { resetAiRateLimitBuckets } from '../src/modules/ai.js';

/**
 * AI 网关（DeepSeek 代理 + 用量统计）
 *
 * 测试用一个**本地假上游**而不是真实 DeepSeek：
 *   1. 不花钱、不需要网络、CI 上能跑；
 *   2. 能精确构造「上游不给 usage」「上游报错」「客户端中途断开」这些
 *      真实环境里要么罕见要么不稳定的分支 —— 而这几个恰恰是最容易写错的地方。
 * 假上游就是真 SSE 流，所以被测的是完整的流式转发路径，不是 mock 出来的。
 */

interface FakeUpstream {
  server: Server;
  port: number;
  /** 已收到的请求体（解析后）。 */
  lastBody: Record<string, unknown> | null;
  /** 让下一次响应以指定状态码失败。 */
  failNext: { status: number; body: string } | null;
  /** 让下一次响应「不给 usage」（测补发逻辑）。 */
  omitUsage: boolean;
  /** 每个 delta 之间的延迟（毫秒），用来制造可中途断开的窗口。 */
  chunkDelayMs: number;
  close: () => Promise<void>;
}

const DUMMY_TEXT = ['咕', '噜', '～', '🐟'];

async function startFakeUpstream(): Promise<FakeUpstream> {
  const state = {
    lastBody: null as Record<string, unknown> | null,
    failNext: null as { status: number; body: string } | null,
    omitUsage: false,
    chunkDelayMs: 5,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        state.lastBody = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        state.lastBody = null;
      }

      if (state.failNext) {
        const { status, body } = state.failNext;
        state.failNext = null;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const write = (obj: unknown): void => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      // 先吐几帧增量
      let i = 0;
      for (const piece of DUMMY_TEXT) {
        if (res.writableEnded || res.destroyed) return;
        write({ choices: [{ delta: { content: piece } }] });
        i += 1;
        await new Promise((r) => setTimeout(r, state.chunkDelayMs));
      }

      if (res.writableEnded || res.destroyed) return;

      // 再吐 usage 帧（DeepSeek 在 stream_options.include_usage 下就是这个样子）
      if (!state.omitUsage) {
        write({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
      }
      if (!res.writableEnded) res.write('data: [DONE]\n\n');
      if (!res.writableEnded) res.end();
      void i;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    get lastBody() {
      return state.lastBody;
    },
    get failNext() {
      return state.failNext;
    },
    set failNext(v: { status: number; body: string } | null) {
      state.failNext = v;
    },
    get omitUsage() {
      return state.omitUsage;
    },
    set omitUsage(v: boolean) {
      state.omitUsage = v;
    },
    get chunkDelayMs() {
      return state.chunkDelayMs;
    },
    set chunkDelayMs(v: number) {
      state.chunkDelayMs = v;
    },
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 直接打真实 HTTP（supertest 对 SSE 流式响应不好处理）。 */
function postChat(
  port: number,
  /** `null` = 不带任何凭据（内置通道的调用方式）。 */
  apiKey: string | null,
  body: Record<string, unknown>,
  opts: { abortAfterFirstChunk?: boolean } = {},
): Promise<{ status: number; frames: string[]; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (apiKey !== null) headers['x-api-key'] = apiKey;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/ai/chat/completions',
        method: 'POST',
        headers,
      },
      (res) => {
        let raw = '';
        let aborted = false;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          // 第一帧到达后立刻断开 —— 模拟「客户端 Ctrl+C」。
          // 这里必须**当场 resolve**：socket 被 destroy 后 'end' 与 'error' 的到达顺序不保证，
          // 等事件等于等一个可能永远不来的信号（表现为用例 5s 超时）。
          if (opts.abortAfterFirstChunk && !aborted && raw.includes('data:')) {
            aborted = true;
            resolve({ status: res.statusCode ?? 0, frames: [], raw });
            res.destroy();
            req.destroy();
          }
        });
        res.on('end', () => {
          if (aborted) return;
          const frames = raw
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim());
          resolve({ status: res.statusCode ?? 0, frames, raw });
        });
        res.on('error', (err) => {
          if (aborted) return;
          reject(err);
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.end(JSON.stringify(body));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AI 网关', () => {
  let t: TestServer;
  let up: FakeUpstream;
  let chatKey: string;
  let readKey: string;
  let noAiKey: string;
  let appId: string;

  beforeEach(async () => {
    up = await startFakeUpstream();
    t = await createTestServer({
      DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${up.port}`,
      // 队列立刻落盘，断言不用等一秒
      AI_USAGE_FLUSH_INTERVAL_MS: '20',
    });
    const app = await createApp(t.request, t.masterKey, 'bigfish', '大肥鱼');
    appId = app.id;
    chatKey = await issueKey(t.request, t.masterKey, { appId, name: 'bigfish-client', scopes: ['ai:chat'] });
    readKey = await issueKey(t.request, t.masterKey, { appId, name: 'bigfish-usage', scopes: ['ai:read'] });
    noAiKey = await issueKey(t.request, t.masterKey, { appId, name: 'legacy', scopes: ['release:read'] });
  });

  afterEach(async () => {
    await up.close();
    t.cleanup();
  });

  const chatBody = {
    app: 'bigfish',
    model: 'deepseek-flash',
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  };

  it('启动即预置模型目录与单价', async () => {
    const res = await t.request.get('/v1/ai/models').set('X-API-Key', readKey);
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { id: string }) => m.id).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    const chat = res.body.items.find((m: { id: string }) => m.id === 'deepseek-flash');
    expect(chat.context).toBe(1048576);
    expect(chat.price_in_cny_per_million).toBe(1);
    expect(chat.price_out_cny_per_million).toBe(4);
  });

  it('流式转发：增量帧 + 补 usage + [DONE]，顺序固定', async () => {
    const port = (t.app.server.address() as { port: number }).port;
    const res = await postChat(port, chatKey, chatBody);

    expect(res.status).toBe(200);

    const parsed = res.frames.map((f) => (f === '[DONE]' ? '[DONE]' : JSON.parse(f)));
    // 增量帧内容
    const contents = parsed
      .filter((f) => typeof f !== 'string' && f.choices?.[0]?.delta?.content)
      .map((f: { choices: Array<{ delta: { content: string } }> }) => f.choices[0].delta.content);
    expect(contents.join('')).toBe(DUMMY_TEXT.join(''));

    // usage 帧必须在 [DONE] 之前，且 choices 为空数组
    const doneIdx = parsed.indexOf('[DONE]');
    const usageIdx = parsed.findIndex((f) => typeof f !== 'string' && f.usage);
    expect(usageIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(usageIdx);

    const usageFrame = parsed[usageIdx] as { choices: unknown[]; usage: Record<string, number> };
    expect(usageFrame.choices).toEqual([]);
    expect(usageFrame.usage.prompt_tokens).toBe(12);
    expect(usageFrame.usage.completion_tokens).toBe(8);
    expect(usageFrame.usage.total_tokens).toBe(20);
    // 12×1/1e6 + 8×4/1e6 = 0.000044 元（flash：输入 1 / 输出 4）
    expect(usageFrame.usage.cost_cny).toBeCloseTo(0.000044, 9);
  });

  it('请求体原样转给上游（含 stream_options.include_usage）', async () => {
    const port = (t.app.server.address() as { port: number }).port;
    await postChat(port, chatKey, { ...chatBody, temperature: 0.3 });
    expect(up.lastBody).not.toBeNull();
    expect(up.lastBody!.model).toBe('deepseek-flash');
    expect(up.lastBody!.stream).toBe(true);
    expect(up.lastBody!.stream_options).toEqual({ include_usage: true });
    expect(up.lastBody!.temperature).toBe(0.3);
  });

  it('上游不给 usage 时，用估算值补一帧 usage（客户端靠它判定流结束）', async () => {
    up.omitUsage = true;
    const port = (t.app.server.address() as { port: number }).port;
    const res = await postChat(port, chatKey, chatBody);

    const usageFrame = res.frames
      .map((f) => (f === '[DONE]' ? null : JSON.parse(f)))
      .find((f) => f && f.usage);
    expect(usageFrame).toBeDefined();
    // 「你好」= 2 个宽字符 → 估算约 2 token；4 个输出字符里 3 个 ASCII + 1 个 emoji
    expect(usageFrame.usage.prompt_tokens).toBeGreaterThan(0);
    expect(usageFrame.usage.completion_tokens).toBeGreaterThan(0);
    expect(usageFrame.usage.total_tokens).toBe(
      usageFrame.usage.prompt_tokens + usageFrame.usage.completion_tokens,
    );
    expect(res.frames[res.frames.length - 1]).toBe('[DONE]');
  });

  it('客户端中途断开：仍然记账，且 status=aborted', async () => {
    up.chunkDelayMs = 50; // 拉长窗口，保证能掐在流中间
    const port = (t.app.server.address() as { port: number }).port;
    await postChat(port, chatKey, chatBody, { abortAfterFirstChunk: true });
    up.chunkDelayMs = 5;

    await sleep(200); // 等队列 flush

    const res = await t.request
      .get(`/v1/ai/usage?app=bigfish&detail=1`)
      .set('X-API-Key', readKey);
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].status).toBe('aborted');
    // 断开的流至少要记到已生成的那部分，不能是全 0
    expect(res.body.requests[0].completion_tokens).toBeGreaterThan(0);
  });

  it('正常流式请求记 status=ok，token 与 usage 接口一致', async () => {
    const port = (t.app.server.address() as { port: number }).port;
    const chat = await postChat(port, chatKey, chatBody);
    await sleep(200);

    const usageFrame = chat.frames
      .map((f) => (f === '[DONE]' ? null : JSON.parse(f)))
      .find((f) => f && f.usage);

    const res = await t.request.get('/v1/ai/usage?app=bigfish&detail=1').set('X-API-Key', readKey);
    expect(res.status).toBe(200);
    expect(res.body.total.total_tokens).toBe(usageFrame.usage.total_tokens);
    expect(res.body.total.cost_cny).toBeCloseTo(usageFrame.usage.cost_cny, 9);
    expect(res.body.requests[0].status).toBe('ok');
    expect(res.body.requests[0].model).toBe('deepseek-flash');
    expect(res.body.requests[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('不带 ai:chat 的 Key → 403 SCOPE_DENIED，details 列出 required/granted', async () => {
    const res = await t.request
      .post('/v1/ai/chat/completions')
      .set('X-API-Key', noAiKey)
      .send(chatBody);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCOPE_DENIED');
    expect(res.body.error.details.required).toEqual(['ai:chat']);
    expect(res.body.error.details.granted).toEqual(['release:read']);
  });

  it('契约要求：Authorization: Bearer <APIKey> 也要认（客户端就是这么调的）', async () => {
    const port = (t.app.server.address() as { port: number }).port;
    const res = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/ai/chat/completions',
          method: 'POST',
          // 刻意**不带** x-api-key，只带 Authorization —— 与契约一致
          headers: { 'content-type': 'application/json', authorization: `Bearer ${chatKey}` },
        },
        (r) => {
          let buf = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => (buf += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, raw: buf }));
          r.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(chatBody));
    });

    expect(res.status).toBe(200);
    expect(res.raw).toContain('[DONE]');
    expect(res.raw).toContain('"usage"');

    // 用量接口同样认这个头（控制台/运维脚本会用它）
    const usage = await t.request.get('/v1/ai/usage').set('Authorization', `Bearer ${readKey}`);
    expect(usage.status).toBe(200);
  });

  it('Authorization 里放用户 JWT 不会绕过 APIKey 鉴权（AI 路由只认 APIKey）', async () => {
    const res = await t.request
      .post('/v1/ai/chat/completions')
      .set('Authorization', 'Bearer not-an-api-key')
      .send(chatBody);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('不带 ai:read 的 Key 查用量 → 403', async () => {
    const res = await t.request.get('/v1/ai/usage').set('X-API-Key', chatKey);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCOPE_DENIED');
  });

  it('模型不在白名单 → 400 AI_MODEL_NOT_ALLOWED', async () => {
    const res = await t.request
      .post('/v1/ai/chat/completions')
      .set('X-API-Key', chatKey)
      .send({ ...chatBody, model: 'gpt-4o' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AI_MODEL_NOT_ALLOWED');
    expect(res.body.error.details.allowed).toContain('deepseek-flash');
  });

  it('上游未配置凭据 → 503 AI_DISABLED（而不是 500）', async () => {
    const off = await createTestServer({ DEEPSEEK_API_KEY: '' });
    const app = await createApp(off.request, off.masterKey, 'off-app', '未启用');
    const key = await issueKey(off.request, off.masterKey, { appId: app.id, name: 'k', scopes: ['ai:chat'] });
    const res = await off.request
      .post('/v1/ai/chat/completions')
      .set('X-API-Key', key)
      .send(chatBody);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_DISABLED');
    off.cleanup();
  });

  it('上游 5xx → 502 AI_UPSTREAM_ERROR，details 带上游状态，且记 error', async () => {
    up.failNext = { status: 500, body: '{"error":"upstream boom"}' };
    const port = (t.app.server.address() as { port: number }).port;
    const res = await postChat(port, chatKey, chatBody);

    expect(res.status).toBe(502);
    const body = JSON.parse(res.raw) as { error: { code: string; details: { upstreamStatus: number } } };
    expect(body.error.code).toBe('AI_UPSTREAM_ERROR');
    expect(body.error.details.upstreamStatus).toBe(500);

    await sleep(200);
    const usage = await t.request.get('/v1/ai/usage?app=bigfish&detail=1').set('X-API-Key', readKey);
    expect(usage.body.requests[0].status).toBe('error');
    expect(usage.body.requests[0].error_code).toBe('AI_UPSTREAM_ERROR');
  });

  it('用量聚合：groupBy=day / app / model', async () => {
    const port = (t.app.server.address() as { port: number }).port;
    await postChat(port, chatKey, chatBody);
    await postChat(port, chatKey, { ...chatBody, model: 'deepseek-v4-pro' });
    await sleep(200);

    const byModel = await t.request.get('/v1/ai/usage?groupBy=model').set('X-API-Key', readKey);
    expect(byModel.status).toBe(200);
    expect(byModel.body.items.map((i: { key: string }) => i.key).sort()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);

    const byApp = await t.request.get('/v1/ai/usage?groupBy=app').set('X-API-Key', readKey);
    expect(byApp.body.items).toHaveLength(1);
    expect(byApp.body.items[0].requests).toBe(2);

    const byDay = await t.request.get('/v1/ai/usage?groupBy=day').set('X-API-Key', readKey);
    expect(byDay.body.items).toHaveLength(1);
    expect(byDay.body.items[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // total 必须等于所有分组之和
    const sum = byModel.body.items.reduce(
      (acc: number, i: { total_tokens: number }) => acc + i.total_tokens,
      0,
    );
    expect(byModel.body.total.total_tokens).toBe(sum);
  });

  it('Master Key 调价后，后续请求按新价计费（价格缓存要失效）', async () => {
    const patch = await t.request
      .patch('/v1/ai/models/deepseek-flash')
      .set('X-Master-Key', t.masterKey)
      .send({ price_out_cny_per_million: 100 });
    expect(patch.status).toBe(200);
    expect(patch.body.price_out_cny_per_million).toBe(100);

    const port = (t.app.server.address() as { port: number }).port;
    const res = await postChat(port, chatKey, chatBody);
    const usageFrame = res.frames
      .map((f) => (f === '[DONE]' ? null : JSON.parse(f)))
      .find((f) => f && f.usage);
    // 12×1/1e6 + 8×100/1e6 = 0.000812
    expect(usageFrame.usage.cost_cny).toBeCloseTo(0.000812, 9);
  });

  it('普通 Key 不能调价（只有 Master Key 能）', async () => {
    const res = await t.request
      .patch('/v1/ai/models/deepseek-flash')
      .set('X-API-Key', readKey)
      .send({ price_out_cny_per_million: 1 });
    expect(res.status).toBe(401);
  });

  it('按 app 维度的限流：超配额返回 429 RATE_LIMITED', async () => {
    const limited = await createTestServer({
      DEEPSEEK_API_KEY: 'sk-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${up.port}`,
      AI_USAGE_FLUSH_INTERVAL_MS: '20',
      AI_RATE_LIMIT_MAX: '2',
    });
    const app = await createApp(limited.request, limited.masterKey, 'flood', '刷量');
    const key = await issueKey(limited.request, limited.masterKey, { appId: app.id, name: 'k', scopes: ['ai:chat'] });
    const port = (limited.app.server.address() as { port: number }).port;

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await postChat(port, key, chatBody)).status);
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses[2]).toBe(429);

    const last = await limited.request
      .post('/v1/ai/chat/completions')
      .set('X-API-Key', key)
      .send(chatBody);
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');

    limited.cleanup();
  });
});

/* ═════════════════════════════════════════════════════════════════════
   内置通道（embedded）：无 Key 调用
   ═════════════════════════════════════════════════════════════════════ */

describe('AI 内置通道（无 Key）', () => {
  let t: TestServer;
  let up: FakeUpstream;
  let bigfishAppId: string;
  let otherKey: string;

  const chatBody = {
    app: 'bigfish',
    model: 'deepseek-flash',
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  };

  beforeEach(async () => {
    // 桶键 `embedded:127.0.0.1:bigfish` 跨用例恒定，不复位会让限流用例互相污染
    resetAiRateLimitBuckets();
    up = await startFakeUpstream();
    t = await createTestServer({
      DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${up.port}`,
      AI_USAGE_FLUSH_INTERVAL_MS: '20',
      AI_EMBEDDED_APPS: 'bigfish',
      AI_EMBEDDED_RATE_LIMIT_MAX: '3',
    });
    const bigfish = await createApp(t.request, t.masterKey, 'bigfish', '大肥鱼');
    bigfishAppId = bigfish.id;
    const other = await createApp(t.request, t.masterKey, 'other-app', '别的应用');
    otherKey = await issueKey(t.request, t.masterKey, { appId: other.id, name: 'other', scopes: ['ai:chat', 'ai:read'] });
  });

  afterEach(async () => {
    await up.close();
    await t.cleanup();
  });

  const serverPort = (): number => (t.app.server.address() as { port: number }).port;

  it('无 Key + app=bigfish → 200 流式 + usage + [DONE]，记账 key_id=embedded', async () => {
    const res = await postChat(serverPort(), null, chatBody);
    expect(res.status).toBe(200);

    const parsed = res.frames.map((f) => (f === '[DONE]' ? '[DONE]' : JSON.parse(f)));
    const contents = parsed
      .filter((f) => typeof f !== 'string' && f.choices?.[0]?.delta?.content)
      .map((f: { choices: Array<{ delta: { content: string } }> }) => f.choices[0].delta.content);
    expect(contents.join('')).toBe(DUMMY_TEXT.join(''));

    const doneIdx = parsed.indexOf('[DONE]');
    const usageIdx = parsed.findIndex((f) => typeof f !== 'string' && f.usage);
    expect(usageIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(usageIdx);
    const usageFrame = parsed[usageIdx] as { usage: Record<string, number> };
    expect(usageFrame.usage.total_tokens).toBe(20);

    await sleep(80); // 等队列 flush（间隔 20ms）
    const row = t.sqlite
      .prepare('select app_id, key_id, status, total_tokens from ai_usage order by created_at desc limit 1')
      .get() as { app_id: string; key_id: string; status: string; total_tokens: number };
    expect(row.app_id).toBe(bigfishAppId);
    expect(row.key_id).toBe('embedded');
    expect(row.status).toBe('ok');
    expect(row.total_tokens).toBe(20);
  });

  it('无 Key + app 不存在 / 非白名单 / 缺 app → 一律 401，且不泄露白名单内容', async () => {
    const notExist = await postChat(serverPort(), null, { ...chatBody, app: 'no-such-app' });
    expect(notExist.status).toBe(401);

    // other-app 真实存在但不在白名单里
    const notListed = await postChat(serverPort(), null, { ...chatBody, app: 'other-app' });
    expect(notListed.status).toBe(401);

    const noApp = await postChat(serverPort(), null, { model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: '你好' }] });
    expect(noApp.status).toBe(401);

    for (const res of [notExist, notListed, noApp]) {
      const body = JSON.parse(res.raw) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      // 错误文案不得出现任何白名单 slug —— 否则可被用来逐个探测
      expect(body.error.message).not.toContain('bigfish');
      expect(body.error.message).not.toContain('other-app');
    }
  });

  it('AI_EMBEDDED_APPS 为空（内置通道关闭）→ 无 Key 一律 401', async () => {
    const off = await createTestServer({
      DEEPSEEK_API_KEY: 'sk-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${up.port}`,
      AI_USAGE_FLUSH_INTERVAL_MS: '20',
      AI_EMBEDDED_APPS: '',
    });
    try {
      await createApp(off.request, off.masterKey, 'bigfish', '大肥鱼');
      const port = (off.app.server.address() as { port: number }).port;
      const res = await postChat(port, null, chatBody);
      expect(res.status).toBe(401);
      expect((JSON.parse(res.raw) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    } finally {
      await off.cleanup();
    }
  });

  it('无 Key + max_tokens=100000 → 被强制压到 4096（截断而非报错）', async () => {
    const res = await postChat(serverPort(), null, { ...chatBody, max_tokens: 100000 });
    expect(res.status).toBe(200);
    expect(up.lastBody).not.toBeNull();
    expect(up.lastBody!.max_tokens).toBe(4096);
  });

  it('带 Key + max_tokens > 32000 → 400（既有行为保持：不透传给上游）', async () => {
    const res = await postChat(serverPort(), otherKey, { ...chatBody, app: 'other-app', max_tokens: 50000 });
    expect(res.status).toBe(400);
    expect((JSON.parse(res.raw) as { error: { code: string } }).error.code).toBe('VALIDATION');
    expect(up.lastBody?.max_tokens).not.toBe(50000);
  });

  it('内置通道限流：第 4 次/分钟（上限 3）→ 429 RATE_LIMITED', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await postChat(serverPort(), null, chatBody)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it('日配额用尽 → 429 AI_QUOTA_EXCEEDED + details.resetAt', async () => {
    const quota = await createTestServer({
      DEEPSEEK_API_KEY: 'sk-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${up.port}`,
      AI_USAGE_FLUSH_INTERVAL_MS: '20',
      AI_EMBEDDED_APPS: 'bigfish',
      // 假上游每次恰好 20 token：第一次过（0<20），落库后 used=20 → 第二次被挡
      AI_EMBEDDED_DAILY_TOKENS: '20',
    });
    try {
      await createApp(quota.request, quota.masterKey, 'bigfish', '大肥鱼');
      const port = (quota.app.server.address() as { port: number }).port;

      const first = await postChat(port, null, chatBody);
      expect(first.status).toBe(200);

      await sleep(80); // 等第一次的 20 token 落库
      const second = await postChat(port, null, chatBody);
      expect(second.status).toBe(429);
      const body = JSON.parse(second.raw) as { error: { code: string; details: { limit: number; used: number; resetAt: number } } };
      expect(body.error.code).toBe('AI_QUOTA_EXCEEDED');
      expect(body.error.details.limit).toBe(20);
      expect(body.error.details.used).toBe(20);
      // resetAt = 北京时间明天零点：在未来一天内，且按天对齐
      const now = Date.now();
      expect(body.error.details.resetAt).toBeGreaterThan(now);
      expect(body.error.details.resetAt).toBeLessThanOrEqual(now + 86_400_000);
    } finally {
      await quota.cleanup();
    }
  });

  it('无 Key 查用量：?app=bigfish 只回自己的聚合；不带 app → 401；detail=1 → 403', async () => {
    // bigfish 走 embedded 一次；other-app 走 Key 一次 —— embedded 查询必须看不到 other 的
    await postChat(serverPort(), null, chatBody);
    await postChat(serverPort(), otherKey, { ...chatBody, app: 'other-app' });
    await sleep(80);

    const res = await t.request.get('/v1/ai/usage?app=bigfish&groupBy=app');
    expect(res.status).toBe(200);
    expect(res.body.total.requests).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].key).toBe(bigfishAppId);

    const noApp = await t.request.get('/v1/ai/usage');
    expect(noApp.status).toBe(401);

    const detail = await t.request.get('/v1/ai/usage?app=bigfish&detail=1');
    expect(detail.status).toBe(403);
    expect(detail.body.error.code).toBe('FORBIDDEN');

    // 对照：bigfish 的真 Key 查明细不受影响（能看到 embedded 流量）
    const fishKey = await issueKey(t.request, t.masterKey, { appId: bigfishAppId, name: 'fish-read', scopes: ['ai:read'] });
    const keyed = await t.request.get('/v1/ai/usage?detail=1').set('X-API-Key', fishKey);
    expect(keyed.status).toBe(200);
    expect(keyed.body.requests.some((r: { key_id: string }) => r.key_id === 'embedded')).toBe(true);
  });
});
