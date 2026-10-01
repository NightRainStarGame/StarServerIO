import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@ssio/shared';
import { cardBatches, cards } from '../db/schema.js';
import { newId } from '../db/client.js';
import { seal, unseal } from '../lib/seal.js';
import { NullableInteger, NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

/** 去掉了易混字符 0 / O / 1 / I / l —— 卡密要被人工抄写和口述。 */
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUP_SIZE = 4;
const DEFAULT_CODE_LENGTH = 12;
const MAX_TOTAL = 100_000;
/** 导出链接有效期：10 分钟。 */
const EXPORT_TTL_SEC = 600;

const SEAL_PURPOSE = 'card-export';
const URL_PURPOSE = 'card-export-url';

function normalizeCode(input: string): string {
  // 用户输入可能带/不带分隔符、可能小写：统一后再算哈希
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(appId: string, normalized: string): string {
  return createHash('sha256').update(`${appId}:${normalized}`).digest('hex');
}

function formatCode(raw: string): string {
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP_SIZE) groups.push(raw.slice(i, i + GROUP_SIZE));
  return groups.join('-');
}

/** 掩码：只留首尾各 4 位，中间固定 4 个星号。 */
function maskCode(raw: string): string {
  return `${raw.slice(0, GROUP_SIZE)}-****-${raw.slice(-GROUP_SIZE)}`;
}

/**
 * 无偏随机字符。
 *
 * 32 个字符刚好整除 256（32 × 8 = 256），所以不需要拒绝采样 ——
 * 用 `byte % 32` 是均匀的。换成其它字符集长度时必须重新审视这一点。
 */
function randomChars(length: number): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(length);
    for (const b of buf) {
      out += CHARSET[b % CHARSET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function deriveUrlKey(secret: string): Buffer {
  return createHash('sha256').update(`${secret}:${URL_PURPOSE}`).digest();
}

function signExport(secret: string, batchId: string, exp: number): string {
  return createHmac('sha256', deriveUrlKey(secret)).update(`${batchId}:${exp}`).digest('hex').slice(0, 32);
}

const BatchSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  name: Type.String(),
  total: Type.Integer(),
  generatedCount: Type.Integer(),
  prefix: NullableString(),
  codeLength: Type.Integer(),
  charset: Type.String(),
  expiresAt: NullableInteger(),
  exportedAt: NullableInteger(),
  createdAt: Type.Integer(),
});

const CreateBatchBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  total: Type.Integer({ minimum: 1, maximum: MAX_TOTAL }),
  prefix: Type.Optional(Type.String({ maxLength: 8, pattern: '^[A-Z0-9]*$' })),
  codeLength: Type.Optional(Type.Integer({ minimum: 4, maximum: 32 })),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
  expiresAt: Type.Optional(NullableInteger()),
});

/**
 * 发卡。
 *
 * 三条红线：
 * 1. 明文只在生成瞬间存在，落库只有 `sha256(appId + code)`；
 * 2. 导出用一次性链接，导出成功即销毁密文；
 * 3. 核销走 `UPDATE ... WHERE status='unused'` 的受影响行数判定，
 *    并发下只有一个人能拿到「首次核销」，其余走幂等分支。
 */
export async function registerCards(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db, config } = opts;

  /** Master Key 或持有 `admin:*` 的 Key —— 普通业务 Key 无权生成卡密。 */
  function requireMasterOrAdmin() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (req.headers['x-master-key']) {
        await app.requireMaster()(req, reply);
        return;
      }
      await app.requireApiKey({ scopes: ['admin:*'] })(req, reply);
    };
  }

  /** 核销方：业务服务端（APIKey + cards:redeem）或终端用户（JWT）皆可。 */
  function requireRedeemCaller() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (req.headers['x-api-key']) {
        await app.requireApiKey({ scopes: ['cards:redeem'] })(req, reply);
        return;
      }
      await app.requireUser()(req, reply);
    };
  }

  app.post(
    '/v1/cards/batches',
    {
      preHandler: [requireMasterOrAdmin()],
      schema: {
        body: CreateBatchBody,
        response: {
          201: Type.Intersect([
            BatchSchema,
            Type.Object({
              exportUrl: Type.String(),
              exportExpiresAt: Type.Integer(),
              // 回给调用方便于观察生成规模上限（Fastify 序列化时会剔除 schema 外的字段）
              generatedInMs: Type.Integer(),
            }),
          ]),
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        name: string;
        total: number;
        prefix?: string;
        codeLength?: number;
        payload?: Record<string, unknown>;
        expiresAt?: number | null;
      };
      // 生成接口的 appId：Master 通道必须显式带 appId，APIKey 通道从凭据里取
      const appId =
        req.ctx.authType === 'master'
          ? ((req.query as { appId?: string }).appId ?? null)
          : (req.ctx.appId ?? null);
      if (!appId) throw new AppError('BAD_REQUEST', 'Master Key 调用时必须带 ?appId=');

      const codeLength = body.codeLength ?? DEFAULT_CODE_LENGTH;
      const prefix = (body.prefix ?? '').toUpperCase();

      const batchId = newId();
      const now = Date.now();
      const generated: string[] = [];
      const seen = new Set<string>();
      while (generated.length < body.total) {
        const raw = `${prefix}${randomChars(codeLength)}`;
        if (seen.has(raw)) continue; // 同批次内去重
        seen.add(raw);
        generated.push(raw);
      }

      db.insert(cardBatches)
        .values({
          id: batchId,
          appId,
          name: body.name,
          total: body.total,
          generatedCount: 0,
          prefix: prefix || null,
          codeLength,
          charset: CHARSET,
          payload: body.payload ?? null,
          exportCiphertext: null,
          exportedAt: null,
          expiresAt: body.expiresAt ?? null,
          createdAt: now,
        })
        .run();

      // 1 万张要在 5 秒内完成：整批放进一个事务，避免每条一次 fsync
      const started = Date.now();
      db.transaction((tx) => {
        for (const raw of generated) {
          tx.insert(cards)
            .values({
              id: newId(),
              batchId,
              codeHash: hashCode(appId, raw),
              codeMask: maskCode(raw),
              status: 'unused',
              usedByUserId: null,
              usedAt: null,
              createdAt: now,
            })
            .run();
        }
        // 明文只以密文形式暂存，供一次性导出
        tx.update(cardBatches)
          .set({
            generatedCount: generated.length,
            exportCiphertext: seal(config.JWT_SECRET, SEAL_PURPOSE, JSON.stringify(generated.map(formatCode))),
          })
          .where(eq(cardBatches.id, batchId))
          .run();
      });
      const elapsed = Date.now() - started;

      const exp = Date.now() + EXPORT_TTL_SEC * 1000;
      const sig = signExport(config.JWT_SECRET, batchId, exp);
      const exportUrl = `/v1/cards/batches/${batchId}/export?exp=${exp}&sig=${sig}`;

      void reply.code(201);
      return {
        id: batchId,
        appId,
        name: body.name,
        total: body.total,
        generatedCount: generated.length,
        prefix: prefix || null,
        codeLength,
        charset: CHARSET,
        expiresAt: body.expiresAt ?? null,
        exportedAt: null,
        createdAt: now,
        exportUrl,
        exportExpiresAt: exp,
        // 生成耗时一并回给调用方，便于观察规模上限（不进日志）
        generatedInMs: elapsed,
      };
    },
  );

  app.get(
    '/v1/cards/batches',
    { preHandler: [requireMasterOrAdmin()], schema: { response: { 200: Type.Array(BatchSchema) } } },
    async (req) => {
      const rows =
        req.ctx.authType === 'master'
          ? db.select().from(cardBatches).all()
          : db.select().from(cardBatches).where(eq(cardBatches.appId, req.ctx.appId!)).all();
      return rows.map((r) => ({
        id: r.id,
        appId: r.appId,
        name: r.name,
        total: r.total,
        generatedCount: r.generatedCount,
        prefix: r.prefix,
        codeLength: r.codeLength,
        charset: r.charset,
        expiresAt: r.expiresAt,
        exportedAt: r.exportedAt,
        createdAt: r.createdAt,
      }));
    },
  );

  app.get('/v1/cards/batches/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };

    // 两种进入方式：一次性签名链接（给浏览器/下载器），或管理员凭据
    const viaSignature = Boolean(exp && sig);
    if (viaSignature) {
      const expected = signExport(config.JWT_SECRET, id, Number(exp));
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(sig!, 'utf8');
      const ok = a.length === b.length && timingSafeEqual(a, b) && Number(exp) > Date.now();
      if (!ok) throw new AppError('UNAUTHORIZED', '导出链接无效或已过期');
    } else {
      await requireMasterOrAdmin()(req, reply);
    }

    const batch = db.select().from(cardBatches).where(eq(cardBatches.id, id)).get();
    if (!batch) throw new AppError('NOT_FOUND', '批次不存在');
    if (batch.exportedAt !== null || !batch.exportCiphertext) {
      throw new AppError('CONFLICT', '该批次的明文已导出过，不可二次获取');
    }

    const plaintext = unseal(config.JWT_SECRET, SEAL_PURPOSE, batch.exportCiphertext);
    const codes = JSON.parse(plaintext) as string[];

    // 一次性：导出成功立刻销毁密文，链接随之失效
    db.update(cardBatches)
      .set({ exportedAt: Date.now(), exportCiphertext: null })
      .where(eq(cardBatches.id, id))
      .run();

    void reply.header('Content-Type', 'text/csv; charset=utf-8');
    void reply.header('Content-Disposition', `attachment; filename="cards-${id}.csv"`);
    return reply.send(`code\n${codes.join('\n')}\n`);
  });

  app.post(
    '/v1/cards/redeem',
    {
      preHandler: [requireRedeemCaller()],
      schema: {
        body: Type.Object({ code: Type.String({ minLength: 4, maxLength: 64 }) }),
        response: {
          200: Type.Object({
            codeMask: Type.String(),
            status: Type.String(),
            /** 本次是否首次核销成功。false 表示幂等返回。 */
            redeemed: Type.Boolean(),
            usedAt: NullableInteger(),
            payload: Type.Unknown(),
          }),
        },
      },
    },
    async (req) => {
      const { code } = req.body as { code: string };
      const appId = req.ctx.appId!;
      const normalized = normalizeCode(code);
      const hash = hashCode(appId, normalized);

      const card = db.select().from(cards).where(eq(cards.codeHash, hash)).get();
      if (!card) throw new AppError('NOT_FOUND', '卡密不存在');
      if (card.status === 'disabled') throw new AppError('FORBIDDEN', '卡密已停用');

      const batch = db.select().from(cardBatches).where(eq(cardBatches.id, card.batchId)).get();
      if (batch && batch.expiresAt !== null && batch.expiresAt <= Date.now()) {
        throw new AppError('BAD_REQUEST', '卡密已过期');
      }

      const now = Date.now();
      let claimed = false;
      db.transaction((tx) => {
        // 关键：把「未被核销」写进 WHERE，由数据库判定谁抢到
        const res = tx
          .update(cards)
          .set({ status: 'used', usedByUserId: req.ctx.userId ?? null, usedAt: now })
          .where(and(eq(cards.id, card.id), eq(cards.status, 'unused')))
          .run();
        claimed = Number((res as unknown as { changes?: number }).changes ?? 0) === 1;
      });

      const fresh = db.select().from(cards).where(eq(cards.id, card.id)).get()!;
      return {
        codeMask: card.codeMask,
        status: fresh.status,
        redeemed: claimed,
        // 幂等返回时给的是「首次核销时间」，业务方据此判断是不是重复提交
        usedAt: fresh.usedAt,
        payload: batch?.payload ?? null,
      };
    },
  );

  app.get(
    '/v1/cards/:codeMask/status',
    {
      preHandler: [app.requireApiKey({ scopes: ['cards:redeem'] })],
      schema: {
        response: {
          200: Type.Object({
            codeMask: Type.String(),
            status: Type.String(),
            usedAt: NullableInteger(),
          }),
        },
      },
    },
    async (req) => {
      const { codeMask } = req.params as { codeMask: string };
      const row = db.select().from(cards).where(eq(cards.codeMask, codeMask)).get();
      if (!row) throw new AppError('NOT_FOUND', '卡密不存在');
      return { codeMask: row.codeMask, status: row.status, usedAt: row.usedAt };
    },
  );
}
