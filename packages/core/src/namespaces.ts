import type { AuthTokens, UserSelf } from '@ssio/shared';
import type { AnnouncementsNamespace, AuthNamespace, CardsNamespace, FilesNamespace, RawBody, ReleasesNamespace, RequestOptions } from './types.js';

type Request = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;
type SaveTokens = (t: AuthTokens | null) => Promise<void>;

export function buildNamespaces(request: Request, saveTokens: SaveTokens) {
  const auth: AuthNamespace = {
    async register(input) {
      const res = await request<AuthTokens & { user: UserSelf }>('POST', '/v1/auth/register', { body: input });
      await saveTokens(res);
      return res;
    },
    async login(input) {
      const res = await request<AuthTokens & { user: UserSelf }>('POST', '/v1/auth/login', { body: input });
      await saveTokens(res);
      return res;
    },
    me: () => request<UserSelf>('GET', '/v1/auth/me'),
    async refresh(refreshToken: string) {
      const res = await request<AuthTokens>('POST', '/v1/auth/refresh', { body: { refreshToken }, skipAuth: true });
      await saveTokens(res);
      return res;
    },
    async logout(refreshToken?: string) {
      await request('POST', '/v1/auth/logout', { body: { refreshToken } });
      // 服务端已吊销，本地登录态一律清掉（包括全设备下线的场景）
      await saveTokens(null);
    },
  };

  const files: FilesNamespace = {
    initUpload: (input) => request('POST', '/v1/storage/uploads', { body: input }),
    putChunk: (uploadId, index, data) => request('PUT', `/v1/storage/uploads/${uploadId}/chunks/${index}`, { raw: data as RawBody }),
    complete: (uploadId, input) => request('POST', `/v1/storage/uploads/${uploadId}/complete`, { body: input }),
    get: (fileId) => request('GET', `/v1/storage/files/${fileId}`),
    downloadUrl: (fileId, ttlSec) =>
      request('GET', `/v1/storage/files/${fileId}/download${ttlSec ? `?ttl=${ttlSec}` : ''}`),
    remove: (fileId, force) => request('DELETE', `/v1/storage/files/${fileId}${force ? '?force=true' : ''}`),
    quota: () => request('GET', '/v1/storage/quota'),
  };

  const releases: ReleasesNamespace = {
    create: (input) => request('POST', '/v1/releases', { body: input }),
    list: (query = {}) => {
      const qs = new URLSearchParams();
      if (query.channel) qs.set('channel', query.channel);
      if (query.platform) qs.set('platform', query.platform);
      if (query.limit) qs.set('limit', String(query.limit));
      if (query.offset) qs.set('offset', String(query.offset));
      const s = qs.toString();
      return request('GET', `/v1/releases${s ? `?${s}` : ''}`);
    },
    get: (id) => request('GET', `/v1/releases/${id}`),
    patch: (id, input) => request('PATCH', `/v1/releases/${id}`, { body: input }),
    remove: (id) => request('DELETE', `/v1/releases/${id}`),
    latest: (query) => {
      const qs = new URLSearchParams({ platform: query.platform });
      if (query.channel) qs.set('channel', query.channel);
      if (query.current) qs.set('current', query.current);
      if (query.arch) qs.set('arch', query.arch);
      if (query.clientId) qs.set('clientId', query.clientId);
      return request('GET', `/v1/releases/latest?${qs.toString()}`);
    },
    download: (id) => request('POST', `/v1/releases/${id}/download`),
  };

  const cards: CardsNamespace = {
    createBatch: (input, query) => {
      const qs = query?.appId ? `?appId=${encodeURIComponent(query.appId)}` : '';
      return request('POST', `/v1/cards/batches${qs}`, { body: input });
    },
    listBatches: () => request('GET', '/v1/cards/batches'),
    redeem: (input) => request('POST', '/v1/cards/redeem', { body: input }),
    status: (codeMask) => request('GET', `/v1/cards/${encodeURIComponent(codeMask)}/status`),
  };

  const announcements: AnnouncementsNamespace = {
    create: (input) => request('POST', '/v1/announcements', { body: input }),
    list: () => request('GET', '/v1/announcements'),
    active: () => request('GET', '/v1/announcements/active'),
    patch: (id, input) => request('PATCH', `/v1/announcements/${id}`, { body: input }),
    remove: (id) => request('DELETE', `/v1/announcements/${id}`),
  };

  return { auth, files, releases, cards, announcements };
}
