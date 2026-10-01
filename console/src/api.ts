/**
 * 控制台的 API 层：两条通道，和 CLI 一致。
 *
 * - Master（X-Master-Key）：应用与 Key 的管理面
 * - APIKey（X-API-Key）：版本 / 卡密 / 公告 / 存储的业务面
 *
 * 不引 @ssio/core 的原因：控制台没有「用户登录态 / 自动续期」这类需求，
 * 而 core 的重试与续期逻辑是围绕用户 JWT 设计的，这里只需要一个薄薄的 fetch。
 */
export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  quotaBytes: number;
  createdAt: number;
}

export interface ReleaseRecord {
  id: string;
  version: string;
  channel: string;
  platform: string;
  arch: string;
  sizeBytes: number;
  sha256: string;
  mandatory: boolean;
  rolloutPercent: number;
  published: boolean;
  downloadCount: number;
  createdAt: number;
}

export interface AnnouncementRecord {
  id: string;
  title: string;
  contentMd: string;
  level: string;
  pinned: boolean;
  startAt: number;
  endAt: number | null;
}

export interface CardBatchRecord {
  id: string;
  appId: string;
  name: string;
  total: number;
  generatedCount: number;
  prefix: string | null;
  codeLength: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface ApiKeyRecord {
  id: string;
  appId: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  opts: { masterKey?: string; apiKey?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.masterKey) headers['X-Master-Key'] = opts.masterKey;
  if (opts.apiKey) headers['X-API-Key'] = opts.apiKey;

  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}${qs}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data as { error?: { code?: string; message?: string } } | null;
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** 业务面：带 APIKey。 */
export function appApi(baseUrl: string, apiKey: string) {
  const call = <T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> =>
    request<T>(baseUrl, method, path, { apiKey, body, query });
  return {
    releases: {
      list: () => call<ReleaseRecord[]>('GET', '/v1/releases'),
      patch: (id: string, body: Partial<Pick<ReleaseRecord, 'published' | 'rolloutPercent' | 'mandatory'>>) =>
        call<ReleaseRecord>('PATCH', `/v1/releases/${id}`, body),
      remove: (id: string) => call<{ deleted: true }>('DELETE', `/v1/releases/${id}`),
    },
    announcements: {
      list: () => call<AnnouncementRecord[]>('GET', '/v1/announcements'),
      create: (body: { title: string; contentMd: string; pinned?: boolean; level?: string }) =>
        call<AnnouncementRecord>('POST', '/v1/announcements', body),
      remove: (id: string) => call<{ deleted: true }>('DELETE', `/v1/announcements/${id}`),
    },
    quota: () => call<{ usedBytes: number; quotaBytes: number }>('GET', '/v1/storage/quota'),
  };
}

/** 管理面：带 Master Key。 */
export function masterApi(baseUrl: string, masterKey: string) {
  const call = <T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> =>
    request<T>(baseUrl, method, path, { masterKey, body, query });
  return {
    apps: {
      list: () => call<AppRecord[]>('GET', '/v1/apps'),
      create: (body: { slug: string; name: string; quotaBytes?: number }) => call<AppRecord>('POST', '/v1/apps', body),
      update: (id: string, body: { name?: string; quotaBytes?: number }) => call<AppRecord>('PATCH', `/v1/apps/${id}`, body),
      remove: (id: string) => call<{ deleted: true }>('DELETE', `/v1/apps/${id}`),
    },
    keys: {
      list: () => call<ApiKeyRecord[]>('GET', '/v1/keys'),
      issue: (body: { appId: string; name: string; scopes: string[] }) =>
        call<{ id: string; key: string }>('POST', '/v1/keys', body),
      revoke: (id: string) => call<{ revoked: true }>('DELETE', `/v1/keys/${id}`),
    },
    cards: {
      list: () => call<CardBatchRecord[]>('GET', '/v1/cards/batches'),
      /**
       * 返回的 `exportUrl` 是**带签名**的一次性链接（?exp=&sig=），可以给用户直接点。
       * 不要自己拼 `/v1/cards/batches/:id/export` —— 那个端点不带签名走管理员凭据，
       * 浏览器裸点会 401。
       */
      create: (body: { name: string; total: number; prefix?: string; expiresAt?: number | null; payload?: unknown }, appId: string) =>
        call<CardBatchRecord & { exportUrl: string }>('POST', '/v1/cards/batches', body, { appId }),
    },
  };
}

/** 常用 scope 清单：签发 Key 时的快捷勾选。 */
export const SCOPE_PRESETS: Array<{ label: string; scopes: string[] }> = [
  { label: '只读（更新检查 + 公告）', scopes: ['release:read', 'announcements:read'] },
  { label: '发版', scopes: ['release:read', 'release:write', 'storage:read', 'storage:write'] },
  { label: '卡密核销', scopes: ['cards:redeem'] },
  { label: '控制台全量', scopes: ['release:read', 'release:write', 'storage:read', 'storage:write', 'cards:redeem', 'announcements:read', 'announcements:write', 'admin:read', 'admin:write'] },
];
