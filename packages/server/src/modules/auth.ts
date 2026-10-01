import { Type } from '@sinclair/typebox';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, type AuthTokens, type IntrospectResult, type UserSelf } from '@ssio/shared';
import { refreshTokens, users } from '../db/schema.js';
import { newId } from '../db/client.js';
import { writeAudit } from '../lib/audit.js';
import { hashApiKey } from '../lib/keys.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  type AccessClaims,
  type RefreshClaims,
} from '../lib/jwt.js';
import { NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const TokensSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  expiresAt: Type.Number(),
});

const UserSelfSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  username: Type.String(),
  nickname: Type.String(),
  avatarFileId: NullableString(),
  status: Type.Union([Type.Literal('active'), Type.Literal('banned')]),
  createdAt: Type.Number(),
  email: NullableString(),
  phone: NullableString(),
});

function toUserSelf(row: typeof users.$inferSelect): UserSelf {
  return {
    id: row.id,
    appId: row.appId,
    username: row.username,
    nickname: row.nickname,
    avatarFileId: row.avatarFileId,
    status: row.status,
    createdAt: row.createdAt,
    email: row.email,
    phone: row.phone,
  };
}

/**
 * 认证模块。
 *
 * 关键约束：`/v1/auth/*` **必须带 APIKey**（否则无法确定用户属于哪个 app），
 * 但 APIKey 不需要 `admin:*` scope —— 用户注册登录是应用的日常操作，不该要求管理员权限。
 */
export async function registerAuth(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db, config } = opts;

  async function issueTokens(userId: string, appId: string): Promise<AuthTokens> {
    const now = Date.now();
    const jti = newId();
    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(config.JWT_SECRET, userId, appId),
      signRefreshToken(config.JWT_SECRET, userId, appId, jti),
    ]);
    db.insert(refreshTokens)
      .values({
        id: jti,
        userId,
        tokenHash: hashApiKey(refreshToken),
        expiresAt: now + REFRESH_TTL_MS,
        revokedAt: null,
        deviceInfo: null,
        createdAt: now,
      })
      .run();
    return { accessToken, refreshToken, expiresAt: now + ACCESS_TTL_MS };
  }

  app.post(
    '/v1/auth/register',
    {
      preHandler: [app.requireApiKey()],
      schema: {
        body: Type.Object({
          username: Type.String({ pattern: '^[A-Za-z0-9_.-]{3,32}$' }),
          password: Type.String({ minLength: 8, maxLength: 128 }),
          nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
          email: Type.Optional(Type.String({ format: 'email', maxLength: 128 })),
          phone: Type.Optional(Type.String({ pattern: '^[0-9+ -]{6,20}$' })),
        }),
        response: { 201: Type.Object({ ...TokensSchema.properties, user: UserSelfSchema }) },
      },
    },
    async (req, reply) => {
      const appId = req.ctx.appId!;
      const body = req.body as {
        username: string;
        password: string;
        nickname?: string;
        email?: string;
        phone?: string;
      };

      const clash = db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.appId, appId), eq(users.username, body.username)))
        .get();
      if (clash) throw new AppError('CONFLICT', '用户名已存在');

      if (body.email) {
        const emailClash = db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.appId, appId), eq(users.email, body.email)))
          .get();
        if (emailClash) throw new AppError('CONFLICT', '邮箱已存在');
      }
      if (body.phone) {
        const phoneClash = db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.appId, appId), eq(users.phone, body.phone)))
          .get();
        if (phoneClash) throw new AppError('CONFLICT', '手机号已存在');
      }

      const row = {
        id: newId(),
        appId,
        username: body.username,
        phone: body.phone ?? null,
        email: body.email ?? null,
        passwordHash: await hashPassword(body.password),
        nickname: body.nickname ?? body.username,
        avatarFileId: null,
        status: 'active' as const,
        createdAt: Date.now(),
      };
      db.insert(users).values(row).run();

      const tokens = await issueTokens(row.id, appId);
      writeAudit(db, { appId, actorType: 'user', actorId: row.id, action: 'auth.register', ip: req.ip });

      void reply.code(201);
      return { ...tokens, user: toUserSelf(row) };
    },
  );

  app.post(
    '/v1/auth/login',
    {
      preHandler: [app.requireApiKey()],
      schema: {
        body: Type.Object({
          username: Type.Optional(Type.String()),
          email: Type.Optional(Type.String()),
          phone: Type.Optional(Type.String()),
          password: Type.String({ minLength: 1 }),
        }),
        response: { 200: Type.Object({ ...TokensSchema.properties, user: UserSelfSchema }) },
      },
    },
    async (req) => {
      const appId = req.ctx.appId!;
      const body = req.body as { username?: string; email?: string; phone?: string; password: string };

      const conditions = [
        body.username ? eq(users.username, body.username) : undefined,
        body.email ? eq(users.email, body.email) : undefined,
        body.phone ? eq(users.phone, body.phone) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      if (conditions.length === 0) throw new AppError('VALIDATION', '需提供 username / email / phone 之一');

      const row = db
        .select()
        .from(users)
        .where(and(eq(users.appId, appId), or(...conditions)))
        .get();

      // 用户不存在与密码错误返回同一错误码，避免账号枚举
      if (!row || !(await verifyPassword(body.password, row.passwordHash))) {
        throw new AppError('UNAUTHORIZED', '账号或密码错误');
      }
      if (row.status === 'banned') throw new AppError('FORBIDDEN', '账号已被封禁');

      const tokens = await issueTokens(row.id, appId);
      writeAudit(db, { appId, actorType: 'user', actorId: row.id, action: 'auth.login', ip: req.ip });
      return { ...tokens, user: toUserSelf(row) };
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      preHandler: [app.requireApiKey()],
      schema: { body: Type.Object({ refreshToken: Type.String() }), response: { 200: TokensSchema } },
    },
    async (req) => {
      const appId = req.ctx.appId!;
      const { refreshToken } = req.body as { refreshToken: string };

      const verified = await verifyToken<RefreshClaims>(config.JWT_SECRET, refreshToken, 'refresh');
      if (!verified.ok) {
        throw verified.expired ? new AppError('TOKEN_EXPIRED', 'refresh token 已过期，请重新登录') : new AppError('UNAUTHORIZED', 'refresh token 无效');
      }
      if (verified.claims.appId !== appId) throw new AppError('UNAUTHORIZED', 'refresh token 不属于该应用');

      const stored = db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashApiKey(refreshToken)))
        .get();
      if (!stored || stored.revokedAt !== null) throw new AppError('UNAUTHORIZED', 'refresh token 已被吊销');
      if (stored.expiresAt <= Date.now()) throw new AppError('TOKEN_EXPIRED', 'refresh token 已过期');

      // 轮换：旧 refresh 立即失效，重放旧 token 会被上面这条拒绝
      const tokens = await issueTokens(stored.userId, appId);
      db.update(refreshTokens).set({ revokedAt: Date.now() }).where(eq(refreshTokens.id, stored.id)).run();
      return tokens;
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      preHandler: [app.requireUser()],
      schema: {
        body: Type.Optional(Type.Object({ refreshToken: Type.Optional(Type.String()) })),
        response: { 200: Type.Object({ revoked: Type.Number() }) },
      },
    },
    async (req) => {
      const userId = req.ctx.userId!;
      const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };

      let revoked = 0;
      if (refreshToken) {
        revoked = db
          .update(refreshTokens)
          .set({ revokedAt: Date.now() })
          .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.tokenHash, hashApiKey(refreshToken))))
          .run().changes;
      } else {
        // 不传 token = 该用户所有设备下线
        revoked = db
          .update(refreshTokens)
          .set({ revokedAt: Date.now() })
          .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
          .run().changes;
      }
      writeAudit(db, { appId: req.ctx.appId, actorType: 'user', actorId: userId, action: 'auth.logout', ip: req.ip });
      return { revoked };
    },
  );

  app.get(
    '/v1/auth/me',
    { preHandler: [app.requireUser()], schema: { response: { 200: UserSelfSchema } } },
    async (req) => {
      const row = db
        .select()
        .from(users)
        .where(and(eq(users.id, req.ctx.userId!), eq(users.appId, req.ctx.appId!)))
        .get();
      if (!row) throw new AppError('NOT_FOUND', '用户不存在');
      return toUserSelf(row);
    },
  );

  /**
   * 业务后端用它校验自己收到的用户 JWT —— 这是 SSIO 作为「被调方」的关键契约。
   * 无效 / 过期 / 跨应用一律 `valid:false`，**不抛 401**，业务方可以直接分支处理。
   */
  app.post(
    '/v1/auth/introspect',
    {
      preHandler: [app.requireApiKey({ scopes: ['auth:read'] })],
      schema: {
        body: Type.Object({ token: Type.String() }),
        response: {
          200: Type.Object({
            valid: Type.Boolean(),
            userId: Type.Optional(Type.String()),
            appId: Type.Optional(Type.String()),
            scopes: Type.Optional(Type.Array(Type.String())),
            nickname: Type.Optional(Type.String()),
            avatarFileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('banned')])),
            exp: Type.Optional(Type.Number()),
          }),
        },
      },
    },
    async (req) => {
      const { token } = req.body as { token: string };
      const verified = await verifyToken<AccessClaims>(config.JWT_SECRET, token, 'access');
      if (!verified.ok) return { valid: false } satisfies IntrospectResult;

      const { sub, appId, exp } = verified.claims;
      // 跨应用 token 视为无效，防止 A 应用的用户凭据被 B 应用复用
      if (appId !== req.ctx.appId) return { valid: false } satisfies IntrospectResult;

      const row = db
        .select()
        .from(users)
        .where(and(eq(users.id, sub), eq(users.appId, appId)))
        .get();
      if (!row) return { valid: false } satisfies IntrospectResult;

      return {
        valid: true,
        userId: row.id,
        appId: row.appId,
        scopes: req.ctx.scopes,
        nickname: row.nickname,
        avatarFileId: row.avatarFileId,
        status: row.status,
        exp,
      } satisfies IntrospectResult;
    },
  );
}
