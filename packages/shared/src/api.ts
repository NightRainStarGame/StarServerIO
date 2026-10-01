/**
 * SSIO 对外 HTTP 契约的 TypeScript 类型（P1：health / apps / keys / auth / users；P2：storage / releases / cards / announcements）。
 *
 * 这是**契约层**：服务端与 SDK 共用同一份类型，任何字段变更都必须在这里体现，
 * 并在交付报告里标注为「契约变更」（会波及所有消费方）。
 *
 * 时间字段统一为 Unix 毫秒整数。
 */

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | Array<{ field?: string; message: string }>;
  };
}

// ---------------------------------------------------------------- 健康检查

export interface HealthzResponse {
  ok: true;
  version: string;
  uptime: number;
}

export interface ReadyzResponse {
  ok: true;
  db: true;
}

// ---------------------------------------------------------------- 应用（租户）

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  /** 存储配额（字节）。P2 起由存储模块消费。 */
  quotaBytes: number;
  createdAt: number;
}

export interface CreateAppRequest {
  slug: string;
  name: string;
  description?: string;
  ownerId?: string | null;
}

// ---------------------------------------------------------------- APIKey

export interface ApiKeyPublic {
  id: string;
  appId: string;
  name: string;
  /** 明文前缀，用于日志与列表展示（不含任何可用凭据片段）。 */
  keyPrefix: string;
  scopes: string[];
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

/** 仅创建接口返回一次，之后无法再取回。 */
export interface ApiKeyIssued extends ApiKeyPublic {
  key: string;
}

// ---------------------------------------------------------------- 用户

export type UserStatus = 'active' | 'banned';

/** 对消费方可见的用户信息；手机号/邮箱只在 `me` 里对自己可见。 */
export interface UserPublic {
  id: string;
  appId: string;
  username: string;
  nickname: string;
  avatarFileId: string | null;
  status: UserStatus;
  createdAt: number;
}

export interface UserSelf extends UserPublic {
  email: string | null;
  phone: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** access token 过期时间（Unix 毫秒）。 */
  expiresAt: number;
}

export interface RegisterRequest {
  username: string;
  password: string;
  nickname?: string;
  email?: string;
  phone?: string;
}

export interface LoginRequest {
  username?: string;
  email?: string;
  phone?: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface LogoutRequest {
  /** 省略则吊销该用户全部 refresh token（全部设备下线）。 */
  refreshToken?: string;
}

/**
 * 业务后端用自己 app 的 APIKey 校验它收到的用户 JWT。
 * token 无效 / 过期 / 属于别的 app 时 `valid=false`，**不抛 401**，便于业务方直接分支。
 */
export interface IntrospectResult {
  valid: boolean;
  userId?: string;
  appId?: string;
  scopes?: string[];
  nickname?: string;
  avatarFileId?: string | null;
  status?: UserStatus;
  /** token 过期时间（Unix 秒，JWT 标准 `exp`）。 */
  exp?: number;
}

// ---------------------------------------------------------------- 文件存储（P2）

export interface InitUploadRequest {
  filename: string;
  totalSize: number;
  mime?: string | null;
  chunkSize?: number;
}

export interface InitUploadResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  /** 会话过期时间（Unix 毫秒）。 */
  expiresAt: number;
}

export interface PutChunkResponse {
  uploadedChunks: number[];
  receivedBytes: number;
}

export interface CompleteUploadRequest {
  sha256: string;
}

export interface CompleteUploadResponse {
  fileId: string;
  sizeBytes: number;
  sha256: string;
  /** 命中同应用已有内容（秒传）：没有写入新副本。 */
  dedup: boolean;
}

export interface FileRecord {
  id: string;
  appId: string;
  filename: string;
  mime: string | null;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

export interface DownloadUrlResponse {
  url: string;
  expiresAt: number;
  /** 实际生效的 ttl（服务端上限 3600）。 */
  ttl: number;
}

export interface QuotaResponse {
  usedBytes: number;
  quotaBytes: number;
}

// ---------------------------------------------------------------- 发行（P2）

export type ReleaseChannel = 'stable' | 'beta' | 'alpha';
export type ReleasePlatform = 'win' | 'linux' | 'android' | 'any';
export type ReleaseArch = 'x64' | 'arm64' | 'any';

export interface ReleaseRecord {
  id: string;
  appId: string;
  channel: ReleaseChannel;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  version: string;
  fileId: string;
  sizeBytes: number;
  sha256: string;
  notesMd: string | null;
  mandatory: boolean;
  minVersion: string | null;
  rolloutPercent: number;
  published: boolean;
  downloadCount: number;
  createdAt: number;
}

export interface CreateReleaseRequest {
  channel: ReleaseChannel;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  version: string;
  fileId: string;
  notesMd?: string | null;
  mandatory?: boolean;
  minVersion?: string | null;
  rolloutPercent?: number;
  published?: boolean;
}

export interface PatchReleaseRequest {
  mandatory?: boolean;
  rolloutPercent?: number;
  published?: boolean;
  notesMd?: string | null;
}

export interface LatestCheckRequest {
  platform: string;
  channel?: ReleaseChannel;
  /** 客户端当前版本；缺省视为从未安装。 */
  current?: string;
  arch?: string;
  /** 灰度分桶的稳定标识（设备/安装 ID）。 */
  clientId?: string;
}

/** latest 只有两种形态，判别字段是 hasUpdate。 */
export interface LatestUpdate {
  hasUpdate: true;
  /** 版本记录 id：updater 用它回查/计下载。 */
  releaseId: string;
  version: string;
  notes: string | null;
  size: number;
  sha256: string;
  url: string;
  mandatory: boolean;
  publishedAt: number;
}

export interface LatestCheckResponse {
  hasUpdate: boolean;
  releaseId?: string;
  version?: string;
  notes?: string | null;
  size?: number;
  sha256?: string;
  url?: string;
  mandatory?: boolean;
  publishedAt?: number;
}

// ---------------------------------------------------------------- 发卡（P2）

export interface CardBatchRecord {
  id: string;
  appId: string;
  name: string;
  total: number;
  generatedCount: number;
  prefix: string | null;
  codeLength: number;
  charset: string;
  expiresAt: number | null;
  exportedAt: number | null;
  createdAt: number;
  /** 一次性 CSV 明文链接（仅创建响应携带；CSV 导出后销毁）。 */
  exportUrl?: string;
  exportExpiresAt?: number;
  generatedInMs?: number;
}

export interface CreateCardBatchRequest {
  name: string;
  total: number;
  prefix?: string;
  codeLength?: number;
  /** 核销成功后原样返回给业务方的自定义数据。 */
  payload?: Record<string, unknown> | null;
  expiresAt?: number | null;
}

export interface RedeemRequest {
  code: string;
}

export interface RedeemResponse {
  codeMask: string;
  status: string;
  /** 本次是否首次核销成功。false = 幂等返回（已核销过）。 */
  redeemed: boolean;
  usedAt: number | null;
  payload: Record<string, unknown> | null;
}

export interface CardStatusResponse {
  codeMask: string;
  status: string;
  usedAt: number | null;
}

// ---------------------------------------------------------------- 公告（P2）

export type AnnouncementLevel = 'info' | 'warning' | 'urgent';

export interface AnnouncementRecord {
  id: string;
  appId: string;
  title: string;
  contentMd: string;
  level: AnnouncementLevel;
  pinned: boolean;
  startAt: number;
  endAt: number | null;
  createdBy: string | null;
  createdAt: number;
}

export interface CreateAnnouncementRequest {
  title: string;
  contentMd: string;
  level?: AnnouncementLevel;
  pinned?: boolean;
  /** 生效时间（Unix 毫秒），缺省立即生效。 */
  startAt?: number;
  /** 结束时间（Unix 毫秒），null 表示长期有效。 */
  endAt?: number | null;
}

export interface PatchAnnouncementRequest {
  title?: string;
  contentMd?: string;
  level?: AnnouncementLevel;
  pinned?: boolean;
  startAt?: number;
  endAt?: number | null;
}
