/**
 * SSIO 对外 HTTP 契约的 TypeScript 类型（P1 范围：health / apps / keys / auth / users）。
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
