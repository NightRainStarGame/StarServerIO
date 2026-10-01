import type {
  AnnouncementRecord,
  CardBatchRecord,
  CardStatusResponse,
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateAnnouncementRequest,
  CreateCardBatchRequest,
  CreateReleaseRequest,
  DownloadUrlResponse,
  FileRecord,
  InitUploadRequest,
  InitUploadResponse,
  LatestCheckRequest,
  LatestCheckResponse,
  LoginRequest,
  PatchAnnouncementRequest,
  PatchReleaseRequest,
  PutChunkResponse,
  QuotaResponse,
  RedeemRequest,
  RedeemResponse,
  RegisterRequest,
  ReleaseRecord,
} from '@ssio/shared';
import type { AuthTokens, UserSelf } from '@ssio/shared';

/** token 持久化：默认内存（进程退出即丢），web/node 包各自提供持久化实现。 */
export interface KeyValueStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface RetryOptions {
  /** 最大重试次数（不含首发）。默认 3。 */
  max?: number;
  /** 退避基准毫秒，默认 200。指数退避 + 30% 抖动。 */
  baseMs?: number;
}

export interface ClientOptions {
  baseUrl: string;
  /** 应用级 APIKey（X-API-Key）。绝不写日志。 */
  apiKey?: string;
  /**
   * 环境注入 fetch；默认 globalThis.fetch。
   * init 用自定义宽类型而不是 RequestInit：core 承诺「无 DOM」，
   * BodyInit 这类 lib.dom 专有类型在这里不存在。
   */
  fetchImpl?: (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: RawBody | string; signal?: AbortSignal },
  ) => Promise<Response>;
  /** 单请求超时，默认 15000。超时视为网络错误（可重试）。 */
  timeoutMs?: number;
  retry?: RetryOptions;
  /** token 存取成功后的回调（持久化钩子）。 */
  onTokenRefresh?: (tokens: AuthTokens) => void | Promise<void>;
  /** refresh 链断裂（需要重新登录）时触发，且只触发一次清空。 */
  onAuthExpired?: () => void | Promise<void>;
  storage?: KeyValueStorage;
}

/** 原始请求体：环境无关（web 传 ArrayBuffer/Blob，Node 传 Buffer/流）。 */
export type RawBody = ArrayBuffer | Uint8Array | string | ReadableStream<unknown> | Blob;

export interface RequestOptions {
  body?: unknown;
  raw?: RawBody;
  /** 跳过 Bearer 头（refresh 端点自身用，防续期循环）。 */
  skipAuth?: boolean;
  headers?: Record<string, string>;
}

export interface AuthNamespace {
  register(input: RegisterRequest): Promise<AuthTokens & { user: UserSelf }>;
  login(input: LoginRequest): Promise<AuthTokens & { user: UserSelf }>;
  me(): Promise<UserSelf>;
  /** 用 refresh token 换新 token（通常由 SDK 在 401 时自动做，不需要手动调）。 */
  refresh(refreshToken: string): Promise<AuthTokens>;
  logout(refreshToken?: string): Promise<void>;
}

export interface FilesNamespace {
  initUpload(input: InitUploadRequest): Promise<InitUploadResponse>;
  putChunk(uploadId: string, index: number, data: RawBody): Promise<PutChunkResponse>;
  complete(uploadId: string, input: CompleteUploadRequest): Promise<CompleteUploadResponse>;
  get(fileId: string): Promise<FileRecord>;
  /** 取签名下载 URL（ttl 上限 3600 秒）。 */
  downloadUrl(fileId: string, ttlSec?: number): Promise<DownloadUrlResponse>;
  remove(fileId: string, force?: boolean): Promise<{ deleted: true; id: string }>;
  quota(): Promise<QuotaResponse>;
}

export interface ReleasesNamespace {
  create(input: CreateReleaseRequest): Promise<ReleaseRecord>;
  list(query?: { channel?: string; platform?: string; limit?: number; offset?: number }): Promise<ReleaseRecord[]>;
  get(id: string): Promise<ReleaseRecord>;
  patch(id: string, input: PatchReleaseRequest): Promise<ReleaseRecord>;
  remove(id: string): Promise<{ deleted: true; id: string }>;
  latest(query: LatestCheckRequest): Promise<LatestCheckResponse>;
  /** 取版本包的签名下载 URL，服务端会累加下载计数。 */
  download(id: string): Promise<DownloadUrlResponse>;
}

export interface CardsNamespace {
  createBatch(input: CreateCardBatchRequest, query?: { appId?: string }): Promise<CardBatchRecord>;
  listBatches(): Promise<CardBatchRecord[]>;
  redeem(input: RedeemRequest): Promise<RedeemResponse>;
  status(codeMask: string): Promise<CardStatusResponse>;
}

export interface AnnouncementsNamespace {
  create(input: CreateAnnouncementRequest): Promise<AnnouncementRecord>;
  list(): Promise<AnnouncementRecord[]>;
  /** 生效中的公告（置顶优先）。可用用户 JWT 或 APIKey 调用。 */
  active(): Promise<AnnouncementRecord[]>;
  patch(id: string, input: PatchAnnouncementRequest): Promise<AnnouncementRecord>;
  remove(id: string): Promise<{ deleted: true; id: string }>;
}

export interface SsioClient {
  /** 低层请求：错误归一为 SsioError / AuthError。 */
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  /** 自动翻页迭代器。 */
  paginate<T>(path: string, opts?: { limit?: number }): AsyncIterable<T>;
  auth: AuthNamespace;
  files: FilesNamespace;
  releases: ReleasesNamespace;
  cards: CardsNamespace;
  announcements: AnnouncementsNamespace;
  /** 手动设置 / 读取 token（登录态恢复用）。 */
  setTokens(tokens: AuthTokens | null): Promise<void>;
  getTokens(): Promise<AuthTokens | null>;
}
