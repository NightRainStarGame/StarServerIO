import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * SSIO 通用表定义（P1 范围）。
 *
 * 约定：
 * - 主键一律 text（UUID）；
 * - 时间一律 Unix 毫秒整数；
 * - **只有通用表**。任何形如 `xxx_order` / `xxx_store` 的业务表都不属于 SSIO。
 * - 字段名一经发布不得改名（后续模块与迁移都依赖它们）。
 */

export const apps = sqliteTable(
  'apps',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ownerId: text('owner_id'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('uq_apps_slug').on(t.slug)],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    // 只存 sha256(key)，明文仅在签发响应里出现一次
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    expiresAt: integer('expires_at', { mode: 'number' }),
    lastUsedAt: integer('last_used_at', { mode: 'number' }),
    revokedAt: integer('revoked_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('uq_api_keys_hash').on(t.keyHash), index('idx_api_keys_app').on(t.appId)],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    username: text('username').notNull(),
    phone: text('phone'),
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    nickname: text('nickname').notNull(),
    avatarFileId: text('avatar_file_id'),
    status: text('status').$type<'active' | 'banned'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    // SQLite 的 UNIQUE 允许多个 NULL，因此「未填手机/邮箱」不会互相冲突
    uniqueIndex('uq_users_app_username').on(t.appId, t.username),
    uniqueIndex('uq_users_app_phone').on(t.appId, t.phone),
    uniqueIndex('uq_users_app_email').on(t.appId, t.email),
    index('idx_users_app').on(t.appId),
  ],
);

export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'number' }),
    deviceInfo: text('device_info'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('uq_refresh_tokens_hash').on(t.tokenHash), index('idx_refresh_tokens_user').on(t.userId)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_audit_app_created').on(t.appId, t.createdAt)],
);
