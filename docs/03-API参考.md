# SSIO API 参考

> 本文件由 `pnpm gen:api-docs` 从 `packages/server/src/modules/*.ts` **自动生成**，不要手改。
> 生成时间：2026-10-01T09:19:25.181Z | 路由总数：43

鉴权头：Master Key 用 `X-Master-Key`，APIKey 用 `X-API-Key`，用户用 `Authorization: Bearer <access>`。

## 公告（announcements.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/announcements` | APIKey（announcements:write） |
| GET | `/v1/announcements` | APIKey（announcements:read） |
| GET | `/v1/announcements/active` | APIKey（announcements:read）或用户 JWT |
| PATCH | `/v1/announcements/:id` | APIKey（announcements:write） |
| DELETE | `/v1/announcements/:id` | APIKey（announcements:write） |

## APIKey（apikeys.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/keys` | Master Key |
| GET | `/v1/keys` | Master Key |
| DELETE | `/v1/keys/:id` | Master Key |

## 应用（apps.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/apps` | Master Key |
| GET | `/v1/apps` | Master Key |
| GET | `/v1/apps/:id` | Master Key |
| PATCH | `/v1/apps/:id` | Master Key |
| DELETE | `/v1/apps/:id` | Master Key |

## 认证（登录 / 续期）（auth.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/auth/register` | APIKey（无 scope 要求） |
| POST | `/v1/auth/login` | APIKey（无 scope 要求） |
| POST | `/v1/auth/refresh` | APIKey（无 scope 要求） |
| POST | `/v1/auth/logout` | 用户 JWT |
| GET | `/v1/auth/me` | 用户 JWT |
| POST | `/v1/auth/introspect` | APIKey（auth:read） |

## 卡密（cards.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/cards/batches` | Master Key 或 APIKey（admin:*） |
| GET | `/v1/cards/batches` | Master Key 或 APIKey（admin:*） |
| GET | `/v1/cards/batches/:id/export` | 公开 |
| POST | `/v1/cards/redeem` | APIKey（cards:redeem）或用户 JWT |
| GET | `/v1/cards/:codeMask/status` | APIKey（cards:redeem） |

## 健康检查（health.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/v1/healthz` | 公开 |
| GET | `/v1/readyz` | 公开 |

## 发行（releases.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/releases` | APIKey（release:write） |
| GET | `/v1/releases` | APIKey（release:read） |
| GET | `/v1/releases/latest` | APIKey（release:read） |
| GET | `/v1/releases/:id` | APIKey（release:read） |
| PATCH | `/v1/releases/:id` | APIKey（release:write） |
| DELETE | `/v1/releases/:id` | APIKey（release:write） |
| POST | `/v1/releases/:id/download` | APIKey（release:read） |

## 存储（storage.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/v1/storage/uploads` | APIKey（storage:write） |
| PUT | `/v1/storage/uploads/:id/chunks/:index` | APIKey（storage:write） |
| POST | `/v1/storage/uploads/:id/complete` | APIKey（storage:write） |
| DELETE | `/v1/storage/uploads/:id` | APIKey（storage:write） |
| GET | `/v1/storage/files/:id` | APIKey（storage:read） |
| GET | `/v1/storage/files/:id/download` | APIKey（storage:read） |
| DELETE | `/v1/storage/files/:id` | APIKey（storage:write） |
| GET | `/v1/storage/quota` | APIKey（storage:read） |
| GET | `/v1/storage/raw/*` | 公开 |

## 用户（users.ts）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/v1/users/:id` | APIKey（users:read） |

