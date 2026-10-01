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

/** 默认应用存储配额：5 GiB。 */
export const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

export const apps = sqliteTable(
  'apps',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ownerId: text('owner_id'),
    // 存储配额（字节）。超过即拒绝新上传，返回 507
    quotaBytes: integer('quota_bytes', { mode: 'number' }).notNull().default(DEFAULT_QUOTA_BYTES),
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

/* ---------------- P2：存储 ---------------- */

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    ownerId: text('owner_id'),
    filename: text('filename').notNull(),
    mime: text('mime'),
    sizeBytes: integer('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    // 驱动内部的定位键，形如 <appId>/26/10/01/<sha256>
    storageKey: text('storage_key').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'number' }),
  },
  (t) => [
    index('idx_files_app').on(t.appId),
    // 同应用内同内容只存一份：先按 hash 查到就能秒传
    index('idx_files_app_sha').on(t.appId, t.sha256),
  ],
);

export const uploadSessions = sqliteTable(
  'upload_sessions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    uploaderId: text('uploader_id'),
    filename: text('filename').notNull(),
    // 初始化时声明，合并后带到 files.mime（files 是最终落点，session 只是过程态）
    mime: text('mime'),
    totalSize: integer('total_size', { mode: 'number' }).notNull(),
    chunkSize: integer('chunk_size', { mode: 'number' }).notNull(),
    totalChunks: integer('total_chunks', { mode: 'number' }).notNull(),
    /** 已收到的分片下标（json 数组）。完成时才落 files。 */
    uploadedChunks: text('uploaded_chunks', { mode: 'json' }).$type<number[]>().notNull(),
    /** 已接收字节数，用于配额与「累积大小」校验。 */
    receivedBytes: integer('received_bytes', { mode: 'number' }).notNull(),
    fileId: text('file_id'),
    status: text('status').$type<'pending' | 'completed' | 'aborted'>().notNull().default('pending'),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_uploads_app').on(t.appId), index('idx_uploads_expires').on(t.expiresAt)],
);

/* ---------------- P2：Release 发行 ---------------- */

export const releases = sqliteTable(
  'releases',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    channel: text('channel').$type<'stable' | 'beta' | 'alpha'>().notNull(),
    platform: text('platform').$type<'win' | 'linux' | 'android' | 'any'>().notNull(),
    arch: text('arch').$type<'x64' | 'arm64' | 'any'>().notNull(),
    version: text('version').notNull(),
    fileId: text('file_id').notNull(),
    sizeBytes: integer('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    notesMd: text('notes_md'),
    mandatory: integer('mandatory', { mode: 'boolean' }).notNull().default(false),
    /** 低于此版本的客户端强制升级；为空表示不限制。 */
    minVersion: text('min_version'),
    /** 灰度百分比 0-100。100 = 全量。 */
    rolloutPercent: integer('rollout_percent').notNull().default(100),
    published: integer('published', { mode: 'boolean' }).notNull().default(false),
    downloadCount: integer('download_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    // 下架是软删：保留记录供审计，latest 一律跳过
    deletedAt: integer('deleted_at', { mode: 'number' }),
  },
  (t) => [
    // 同一应用 + 渠道 + 平台 + 架构 + 版本号只允许一条
    uniqueIndex('uq_releases_target').on(t.appId, t.channel, t.platform, t.arch, t.version),
    index('idx_releases_lookup').on(t.appId, t.channel, t.platform, t.arch),
  ],
);

/* ---------------- P2：发卡 ---------------- */

export const cardBatches = sqliteTable(
  'card_batches',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    total: integer('total').notNull(),
    generatedCount: integer('generated_count').notNull().default(0),
    prefix: text('prefix'),
    codeLength: integer('code_length').notNull(),
    charset: text('charset').notNull(),
    /** 核销成功后原样返回给业务方的自定义数据。 */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    /**
     * 明文卡密的密文（AES-256-GCM，密钥派生自服务端主密钥）。
     * 只为「一次性导出」临时存在，导出成功即清空 —— 明文永不落库。
     */
    exportCiphertext: text('export_ciphertext'),
    /** 已导出时间。非空表示一次性链接已被消费。 */
    exportedAt: integer('exported_at', { mode: 'number' }),
    expiresAt: integer('expires_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_card_batches_app').on(t.appId)],
);

export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id').notNull(),
    /** sha256(appId + code)：明文永不落库。 */
    codeHash: text('code_hash').notNull(),
    /** 展示用掩码，形如 JB12-****-9XYZ。 */
    codeMask: text('code_mask').notNull(),
    status: text('status').$type<'unused' | 'used' | 'disabled'>().notNull().default('unused'),
    usedByUserId: text('used_by_user_id'),
    usedAt: integer('used_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('uq_cards_hash').on(t.codeHash),
    index('idx_cards_batch').on(t.batchId),
    // 状态查询接受掩码（掩码是唯一对外暴露的形态）
    index('idx_cards_mask').on(t.codeMask),
  ],
);

/* ---------------- P2：公告 ---------------- */

export const announcements = sqliteTable(
  'announcements',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    title: text('title').notNull(),
    contentMd: text('content_md').notNull(),
    level: text('level').$type<'info' | 'warning' | 'urgent'>().notNull().default('info'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    startAt: integer('start_at', { mode: 'number' }).notNull(),
    endAt: integer('end_at', { mode: 'number' }),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_announcements_app').on(t.appId, t.startAt)],
);
