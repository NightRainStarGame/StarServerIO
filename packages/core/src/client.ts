import type { AuthTokens } from '@ssio/shared';
import { AuthError, SsioError } from './error.js';
import type { ClientOptions, KeyValueStorage, RawBody, RequestOptions, SsioClient } from './types.js';
import { buildNamespaces } from './namespaces.js';

const TOKEN_KEY = 'ssio.tokens';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_MAX = 3;
const DEFAULT_RETRY_BASE_MS = 200;

/** 指数退避 + 30% 抖动：多实例同时撞限流时不至于步调一致地重试。 */
function backoff(attempt: number, baseMs: number): number {
  const wait = baseMs * 2 ** attempt;
  return Math.round(wait * (0.7 + Math.random() * 0.6));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memoryStorage(): KeyValueStorage {
  let value: string | null = null;
  return {
    get: () => value,
    set: (_k, v) => {
      value = v;
    },
    remove: () => {
      value = null;
    },
  };
}

interface InternalResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export function createClient(opts: ClientOptions): SsioClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  // 默认走全局 fetch；两侧签名都用自定义宽类型，避免引入 lib.dom 专有类型（core 承诺无 DOM）
  const fetchImpl: NonNullable<ClientOptions['fetchImpl']> =
    opts.fetchImpl ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit | undefined));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMax = opts.retry?.max ?? DEFAULT_RETRY_MAX;
  const retryBaseMs = opts.retry?.baseMs ?? DEFAULT_RETRY_BASE_MS;
  const storage = opts.storage ?? memoryStorage();

  let cached: AuthTokens | null = null;
  /** 并发 401 只允许一个刷新在飞，其余请求等同一个 Promise。 */
  let refreshInFlight: Promise<AuthTokens> | null = null;

  async function loadTokens(): Promise<AuthTokens | null> {
    if (cached) return cached;
    const raw = await storage.get(TOKEN_KEY);
    cached = raw ? (JSON.parse(raw) as AuthTokens) : null;
    return cached;
  }

  async function saveTokens(tokens: AuthTokens | null): Promise<void> {
    cached = tokens;
    if (tokens) {
      await storage.set(TOKEN_KEY, JSON.stringify(tokens));
      await opts.onTokenRefresh?.(tokens);
    } else {
      await storage.remove(TOKEN_KEY);
    }
  }

  function toError(res: InternalResponse): SsioError {
    const env = (res.body ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
    const e = env.error ?? {};
    return new SsioError(e.code ?? 'UNKNOWN', e.message ?? `HTTP ${res.status}`, res.status, e.details);
  }

  /** 单次 HTTP（带超时），不重试不续期 —— 重放逻辑都在上层。 */
  async function once(method: string, path: string, o: RequestOptions): Promise<InternalResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (opts.apiKey) headers['X-API-Key'] = opts.apiKey;
    if (!o.skipAuth) {
      const tk = await loadTokens();
      if (tk) headers.Authorization = `Bearer ${tk.accessToken}`;
    }
    let contentType = 'application/json';
    if (o.raw !== undefined) {
      if (typeof o.raw === 'string') contentType = 'text/plain';
      else if (o.raw instanceof Blob && o.raw.type) contentType = o.raw.type;
      else contentType = 'application/octet-stream';
      headers['Content-Type'] = contentType;
    } else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers,
        body: (o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined)) as RawBody | string | undefined,
        signal: controller.signal,
      });
      const type = res.headers.get('content-type') ?? '';
      let body: unknown = null;
      if (type.includes('application/json')) body = await res.json();
      else if (type.startsWith('text/')) body = await res.text();
      return { status: res.status, headers: res.headers, body };
    } catch (err) {
      throw new SsioError('NETWORK', `请求失败：${err instanceof Error ? err.message : String(err)}`, 0, undefined, err);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 用 refresh token 换新 access。并发调用共享一次请求。 */
  function refreshTokens(): Promise<AuthTokens> {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const cur = await loadTokens();
        if (!cur?.refreshToken) throw new AuthError('登录态已失效，请重新登录');
        const res = await once('POST', '/v1/auth/refresh', {
          body: { refreshToken: cur.refreshToken },
          // refresh 端点自己不能带 Bearer 也不参与续期循环
          skipAuth: true,
        });
        if (res.status >= 300) throw new AuthError('refresh token 已失效，请重新登录', res.status);
        const next = res.body as AuthTokens;
        await saveTokens(next);
        return next;
      })().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    let attempt = 0;
    let refreshedOnce = false;
    for (;;) {
      let res: InternalResponse;
      try {
        res = await once(method, path, o);
      } catch (err) {
        // 网络错误（含超时）：可重试
        if (err instanceof SsioError && err.code === 'NETWORK' && attempt < retryMax) {
          await sleep(backoff(attempt++, retryBaseMs));
          continue;
        }
        throw err;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retryMax) {
          if (res.status === 429) throw toError(res);
          throw toError(res);
        }
        // 429 优先尊重服务器的 Retry-After（秒）
        const ra = Number(res.headers.get('retry-after') ?? 0);
        await sleep(ra > 0 ? ra * 1000 : backoff(attempt++, retryBaseMs));
        continue;
      }

      if (res.status === 401 && !o.skipAuth && !refreshedOnce && (await loadTokens())) {
        // 本地有登录态才尝试续期；只续一次，防止「无效 token + 刷新成功」死循环
        refreshedOnce = true;
        try {
          await refreshTokens();
        } catch (err) {
          await saveTokens(null);
          await opts.onAuthExpired?.();
          throw err;
        }
        continue; // 重放原请求
      }

      // 走到这里只剩 2xx/3xx：2xx 成功，3xx（fetch 未跟随的）视为异常状态
      if (res.status < 300) return res.body as T;
      throw toError(res);
    }
  }

  async function* paginate<T>(path: string, pageOpts: { limit?: number } = {}): AsyncIterable<T> {
    const limit = pageOpts.limit ?? 50;
    const sep = path.includes('?') ? '&' : '?';
    let offset = 0;
    for (;;) {
      const items = await request<T[]>('GET', `${path}${sep}limit=${limit}&offset=${offset}`);
      if (!Array.isArray(items) || items.length === 0) return;
      yield* items;
      if (items.length < limit) return;
      offset += items.length;
    }
  }

  const client: SsioClient = {
    request,
    paginate,
    setTokens: (t) => saveTokens(t),
    getTokens: () => loadTokens(),
    ...buildNamespaces(request, (t) => saveTokens(t)),
  };
  return client;
}
