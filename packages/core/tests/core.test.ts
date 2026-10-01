import { describe, expect, it } from 'vitest';
import { AuthError, createClient, SsioError, type ClientOptions } from '../src/index.js';

/**
 * mock fetch：按「路径 + 可选谓词」路由，记录每次调用的路径与时间戳。
 * P4 验收要求的五条传输层行为全在这里过。
 */

interface Call {
  path: string;
  /** fetch 收到的 input 原文（诊断用）。 */
  full: string;
  at: number;
  auth?: string;
  apiKey?: string;
  init?: RequestInit | undefined;
}

function createMock(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: NonNullable<ClientOptions['fetchImpl']> = (input, init) => {
    const url = new URL(input, 'http://ssio.test');
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const call: Call = {
      path: url.pathname + url.search,
      full: input,
      at: Date.now(),
      auth: headers.get('authorization') ?? undefined,
      apiKey: headers.get('x-api-key') ?? undefined,
      init,
    };
    calls.push(call);
    return Promise.resolve(handler(call)).then((r) => r as Response);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('401 自动续期', () => {
  it('并发 5 个 401 请求只触发一次 refresh，且全部重放成功', async () => {
    let refreshCount = 0;
    const OLD = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 };
    const NEW = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2 };

    const { fetchImpl, calls } = createMock((call) => {
      if (call.path === '/v1/auth/refresh') {
        refreshCount++;
        return jsonResponse(NEW);
      }
      // 业务端点：旧 token → 401 TOKEN_EXPIRED；新 token → 200
      if (call.auth === `Bearer ${NEW.accessToken}`) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'token 过期' } }, 401);
    });

    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl, retry: { max: 0 } });
    await client.setTokens(OLD);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.request<{ ok: boolean }>('GET', '/v1/ping')),
    );
    expect(results).toHaveLength(5);
    expect(refreshCount).toBe(1); // ⭐ 核心断言：只刷一次
    expect(calls.filter((c) => c.path === '/v1/auth/refresh')).toHaveLength(1);
  });

  it('refresh 也失败 → 抛 AuthError，清空登录态并触发 onAuthExpired', async () => {
    let expired = false;
    const { fetchImpl } = createMock((call) => {
      if (call.path === '/v1/auth/refresh') {
        return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'refresh 失效' } }, 401);
      }
      return jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: '过期' } }, 401);
    });

    const client = createClient({
      baseUrl: 'http://ssio.test',
      fetchImpl,
      retry: { max: 0 },
      onAuthExpired: () => {
        expired = true;
      },
    });
    await client.setTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });

    await expect(client.request('GET', '/v1/ping')).rejects.toThrow(AuthError);
    expect(expired).toBe(true);
    expect(await client.getTokens()).toBeNull();
  });

  it('没有登录态时的 401 直接抛，不尝试刷新', async () => {
    const { fetchImpl, calls } = createMock(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '没带 key' } }, 401));
    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl, retry: { max: 0 } });
    await expect(client.request('GET', '/v1/ping')).rejects.toThrow(SsioError);
    expect(calls.filter((c) => c.path === '/v1/auth/refresh')).toHaveLength(0);
  });
});

describe('重试与限流', () => {
  it('429 尊重 Retry-After：下一次请求至少在 1 秒后', async () => {
    const { fetchImpl, calls } = createMock((call) => {
      if (calls.filter((c) => c.path === '/v1/slow').length <= 1 && call.path === '/v1/slow') {
        return jsonResponse({ error: { code: 'RATE_LIMITED', message: '限流' } }, 429, { 'retry-after': '1' });
      }
      return jsonResponse({ ok: true });
    });

    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl, retry: { max: 2, baseMs: 1 } });
    const res = await client.request<{ ok: boolean }>('GET', '/v1/slow');
    expect(res.ok).toBe(true);

    const slow = calls.filter((c) => c.path === '/v1/slow');
    expect(slow).toHaveLength(2);
    expect(slow[1]!.at - slow[0]!.at).toBeGreaterThanOrEqual(900); // ⭐ 核心断言
  });

  it('网络错误重试 3 次（共 4 次请求）后抛 SsioError', async () => {
    let count = 0;
    const { fetchImpl } = createMock(() => {
      count++;
      throw new TypeError('fetch failed');
    });
    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl, retry: { max: 3, baseMs: 1 } });
    await expect(client.request('GET', '/v1/net')).rejects.toSatisfy((e: unknown) => e instanceof SsioError && e.code === 'NETWORK');
    expect(count).toBe(4);
  });

  it('4xx 不重试：只发一次请求，错误信息保留服务端 code/details', async () => {
    const { fetchImpl, calls } = createMock(() =>
      jsonResponse({ error: { code: 'SCOPE_DENIED', message: '权限不足', details: { need: 'storage:write' } } }, 403),
    );
    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl, retry: { max: 3, baseMs: 1 } });
    const err = await client.request('GET', '/v1/forbidden').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SsioError);
    expect((err as SsioError).code).toBe('SCOPE_DENIED');
    expect((err as SsioError).httpStatus).toBe(403);
    expect((err as SsioError).details).toEqual({ need: 'storage:write' });
    expect(calls).toHaveLength(1); // ⭐ 4xx 绝不重试
  });

  it('超时按网络错误处理并可重试', async () => {
    let count = 0;
    const { fetchImpl } = createMock((call) => {
      count++;
      if (count === 1) {
        // 模拟真实 fetch 对 abort 的行为：signal 一触发就 reject，否则永不 resolve
        return new Promise<Response>((_, reject) => {
          (call.init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new TypeError('aborted')),
          );
        });
      }
      return jsonResponse({ ok: true });
    });
    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl, timeoutMs: 50, retry: { max: 1, baseMs: 1 } });
    const res = await client.request<{ ok: boolean }>('GET', '/v1/hang');
    expect(res.ok).toBe(true);
    expect(count).toBe(2);
  });
});

describe('分页', () => {
  it('跨 3 页共 25 条全部取到，无重复无遗漏', async () => {
    const { fetchImpl, calls } = createMock((call) => {
      const url = new URL(call.path, 'http://ssio.test');
      if (url.pathname !== '/v1/items') return jsonResponse([]);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      // 服务端风格：总数 25，第三页只剩 5 条
      const all = Array.from({ length: 25 }, (_, i) => ({ id: i }));
      return jsonResponse(all.slice(offset, offset + limit));
    });

    const client = createClient({ baseUrl: 'http://ssio.test', fetchImpl });
    const got: number[] = [];
    for await (const item of client.paginate<{ id: number }>('/v1/items', { limit: 10 })) got.push(item.id);

    expect(got).toHaveLength(25); // ⭐ 全取到
    expect(new Set(got).size).toBe(25); // ⭐ 无重复
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(calls.filter((c) => c.path.startsWith('/v1/items'))).toHaveLength(3); // ⭐ 恰好 3 页
  });
});

describe('认证头', () => {
  it('APIKey 走 X-API-Key，登录后叠加 Bearer', async () => {
    const { fetchImpl, calls } = createMock(() => jsonResponse({ ok: true }));
    const client = createClient({ baseUrl: 'http://ssio.test', apiKey: 'ssio_live_xxx', fetchImpl, retry: { max: 0 } });
    await client.setTokens({ accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 });
    await client.request('GET', '/v1/ping');

    expect(calls[0]!.apiKey).toBe('ssio_live_xxx');
    expect(calls[0]!.auth).toBe('Bearer a1');
  });
});
