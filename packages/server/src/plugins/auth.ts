import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, hasAllScopes } from '@ssio/shared';
import type { Db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import type { ServerConfig } from '../env.js';
import { hashApiKey, timingSafeEqualStr } from '../lib/keys.js';
import { verifyToken, type AccessClaims } from '../lib/jwt.js';
import type { RequestContext } from '../types.js';

const LAST_USED_THROTTLE_MS = 60_000;

function headerValue(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * 三通道鉴权：APIKey / 用户 JWT / Master Key。
 *
 * 每个接口显式声明自己要哪一条通道，组合成 preHandler 数组，避免「默认放行」。
 */
export function registerAuth(app: FastifyInstance, db: Db, config: ServerConfig): void {
  // Fastify 要求先声明请求属性再赋值。这里只能用 null —— decorateRequest 拒绝引用类型
  // （会抛 "is a reference type"），而每个请求的对象必须在钩子里新建，不能共享。
  app.decorateRequest('ctx', null as unknown as RequestContext);

  app.addHook('onRequest', (req, _reply, done) => {
    const ctx: RequestContext = { authType: 'anonymous', scopes: [] };
    (req as FastifyRequest & { ctx: RequestContext }).ctx = ctx;
    done();
  });

  app.decorate('requireMaster', () => {
    return async function requireMaster(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const provided = headerValue(req.headers['x-master-key']);
      if (!provided || !timingSafeEqualStr(provided, config.MASTER_KEY)) {
        throw new AppError('UNAUTHORIZED', 'Master Key 无效');
      }
      req.ctx = { authType: 'master', scopes: ['admin:*'] };
    };
  });

  app.decorate('requireApiKey', (opts?: { scopes?: string[] }) => {
    return async function requireApiKey(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const provided = headerValue(req.headers['x-api-key']);
      if (!provided) throw new AppError('UNAUTHORIZED', '缺少 X-API-Key 请求头');

      const row = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(provided))).get();
      if (!row) throw new AppError('UNAUTHORIZED', 'APIKey 无效');
      if (row.revokedAt !== null) throw new AppError('KEY_REVOKED');
      if (row.expiresAt !== null && row.expiresAt <= Date.now()) throw new AppError('KEY_EXPIRED');

      if (opts?.scopes?.length && !hasAllScopes(row.scopes, opts.scopes)) {
        throw new AppError('SCOPE_DENIED', 'APIKey 缺少所需 scope', {
          required: opts.scopes,
          granted: row.scopes,
        });
      }

      // lastUsedAt 节流写入：每次请求都更新会让高频客户端白白多一次写事务
      const now = Date.now();
      if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_THROTTLE_MS) {
        db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)).run();
      }

      req.ctx = { authType: 'apikey', appId: row.appId, keyId: row.id, scopes: row.scopes };
    };
  });

  app.decorate('requireUser', () => {
    return async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const auth = headerValue(req.headers.authorization);
      if (!auth || !auth.startsWith('Bearer ')) {
        throw new AppError('UNAUTHORIZED', '缺少 Bearer 令牌');
      }

      const result = await verifyToken<AccessClaims>(config.JWT_SECRET, auth.slice(7), 'access');
      if (!result.ok) {
        throw result.expired ? new AppError('TOKEN_EXPIRED') : new AppError('UNAUTHORIZED', '令牌无效');
      }

      req.ctx = {
        authType: 'user',
        userId: result.claims.sub,
        appId: result.claims.appId,
        scopes: [],
      };
    };
  });
}
