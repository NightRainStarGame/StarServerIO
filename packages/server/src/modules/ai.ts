import { Type } from '@sinclair/typebox';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type AiChatRequest, type AiUsageGroupBy, type AiUsageResponse } from '@ssio/shared';
import { newId } from '../db/client.js';
import { aiModelPrices, aiUsage, apps } from '../db/schema.js';
import type { ModuleOptions } from '../types.js';

/**
 * AI 网关：DeepSeek 代理 + Token 用量统计。
 *
 * ── 为什么要单独一个网关，而不是让客户端直连 DeepSeek ──
 * 真实 key 只能躺在服务端。客户端拿的是 SSIO 的 APIKey（带 `ai:chat`），
 * 于是「谁能花这个钱、花了多少、什么时候花的」三件事都收敛到了这一层：
 * scope 控制能不能调，`ai_usage` 表记账，`/v1/ai/usage` 查账。
 *
 * ── 三个最容易做错的地方 ──
 *
 * 1. **usage 事件必须补发**。客户端把带 `usage` 的那一帧当作「流结束」信号；
 *    上游没给 usage（DeepSeek 在 `stream_options.include_usage` 下才会给，
 *    而中途断开的流更是拿不到）时，若不补一条，客户端会永远停在 loading。
 *    所以这里的收尾顺序是固定的：**先 usage，再 [DONE]**，
 *    上游自己发的 `[DONE]` 会被扣住不发，等我们补完再放行。
 *
 * 2. **客户端断开 ≠ 不记账**。Ctrl+C 的那一次请求上游照样在生成、照样花钱。
 *    所以 `aborted` 也是一条完整的用量记录，只是 status 不同。
 *
 * 3. **落库不能挡在流式响应路径上**。SQLite 是同步的，写一次要几毫秒；
 *    放在流里就等于每个 token 帧都多一次写事务。这里用内存队列 + 定时 flush，
 *    并在服务关闭时强制排空（不排空就等于把最后几条账单丢了）。
 */

/** 模型白名单（2026-10-12 官方 /models 实测）。与 `ai_model_prices` 表内容一致，这里硬编码做准入判断。 */
const ALLOWED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;

/**
 * 首次启动时预置的模型目录与单价（元 / 百万 token）。
 * DeepSeek 公开报价：chat 与 reasoner 的输入价与输出价一致。
 * 后续调价走 `PATCH /v1/ai/models/:model`（Master Key），不发版。
 */
const SEED_MODELS: Array<{
  model: string;
  label: string;
  context: number;
  priceIn: number;
  priceOut: number;
}> = [
  { model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', context: 1_048_576, priceIn: 1, priceOut: 4 },
  { model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', context: 1_048_576, priceIn: 3, priceOut: 12 },
];

/** 上游 SSE 的单帧（只取用得到的字段）。 */
interface UpstreamChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/* ────────────────────────── 用量记录器 ────────────────────────── */

interface PendingUsage {
  id: string;
  appId: string;
  keyId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 微元（1e-6 元）。整数运算，最后除 1e6 才是元。 */
  costMicros: number;
  latencyMs: number;
  status: 'ok' | 'aborted' | 'error';
  errorCode: string | null;
  createdAt: number;
}

/**
 * 用量写入队列。
 *
 * 为什么不在流里直接 insert：better-sqlite3 是同步的，一次 insert 会阻塞事件循环；
 * 而一次对话可能有上百帧，每帧都插一次会让整个服务的 P99 都被拖垮。
 * 队列 + 批量 flush 把「每帧一次写」摊成「每秒最多一次写」。
 */
class UsageRecorder {
  private queue: PendingUsage[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: ModuleOptions['db'],
    private readonly flushIntervalMs = 1000,
    private readonly maxQueue = 50,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  push(row: PendingUsage): void {
    this.queue.push(row);
    // 队列太长（比如定时器被 GC 掉、或突发流量）立刻落盘，避免内存堆积
    if (this.queue.length >= this.maxQueue) this.flush();
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const rows = this.queue.splice(0);
    try {
      this.db.insert(aiUsage).values(rows.map((r) => ({
        id: r.id,
        appId: r.appId,
        keyId: r.keyId,
        model: r.model,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        // 元 = 微元 / 1e6
        costCny: r.costMicros / 1_000_000,
        latencyMs: r.latencyMs,
        status: r.status,
        errorCode: r.errorCode,
        createdAt: r.createdAt,
      }))).run();
    } catch (err) {
      // 记账失败绝不能连带影响已经发出去的流；写日志让运维发现即可
      console.error('[ai] 用量落库失败，本批 %d 条已丢失：', rows.length, err);
    }
  }

  /** 服务关闭时调用：把队列里剩下的全部写完。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

/* ────────────────────────── 按 app 维度的限流 ────────────────────────── */

/**
 * AI 专属限流，按 **appId** 分桶。
 *
 * 为什么不用 `@fastify/rate-limit`：它是 `onRequest` 钩子，跑在鉴权之前，
 * 那时 `req.ctx.appId` 还是空的 —— 只能退化成按 IP 或 Key 分桶。
 * 而 AI 的成本是「按应用」发生的：同一个 app 的多个 Key（客户端 / 测试机 / 灰度）
 * 应该共用一份配额，用 Key 分桶会让限额被绕过 N 倍。
 *
 * 内存实现：本进程单实例，与全局限流同一套前提。
 */
const aiBuckets = new Map<string, number[]>();

function hitAiLimit(appId: string, max: number, windowMs: number): number {
  const now = Date.now();
  const hits = (aiBuckets.get(appId) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  aiBuckets.set(appId, hits);
  // 顺手清掉空桶，防止 appId 无限增长（每个 Key/每个 app 各一个）
  if (aiBuckets.size > 1024) {
    for (const [k, v] of aiBuckets) if (v.length === 0 || now - v[v.length - 1]! > windowMs) aiBuckets.delete(k);
  }
  return hits.length;
}

/** 只在测试之间需要干净状态时用；生产进程不会调用。 */
export function resetAiRateLimitBuckets(): void {
  aiBuckets.clear();
}

/**
 * 兼容 `Authorization: Bearer <APIKey>`。
 *
 * 为什么需要：**客户端契约（大肥鱼）用的是 Authorization 头**，
 * 而 SSIO 全站 APIKey 走的是 `X-API-Key`（见 plugins/auth.ts）。
 * 与其让客户端改一行、还要发版，不如在网关这里做一次「头部搬运」——两个都认。
 *
 * 为什么只放在 AI 路由上、不改全局：全局的 `Authorization` 还背着**用户 JWT** 的语义
 * （requireUser 读的就是它）。全局放开会让两种凭据混在同一个头上，
 * 将来排查「这请求到底以谁的身份进来」会变得很难。
 *
 * ⚠️ 必须是 **async** 的。写成同步函数时 Fastify 会按「回调式钩子」处理 ——
 * 它等一个永远不会来的 `done()`，于是请求挂死（不报错，就是不返回）。
 * 这个坑是被测试抓出来的：所有挂了本钩子的路由集体 5s 超时，
 * 唯独没挂它的 PATCH /v1/ai/models/:model 正常。
 */
async function acceptBearerApiKey(req: FastifyRequest): Promise<void> {
  const auth = req.headers.authorization;
  if (!req.headers['x-api-key'] && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    req.headers['x-api-key'] = auth.slice(7).trim();
  }
}

/* ────────────────────────── 内置通道（embedded） ────────────────────────── */

/** 内置通道限流窗口：固定一分钟（`AI_EMBEDDED_RATE_LIMIT_MAX` 的语义就是「次/分钟」）。 */
const EMBEDDED_WINDOW_MS = 60_000;
/** 内置通道的 max_tokens 硬上限。带 Key 的调用不受此限制（信任等级不同）。 */
const EMBEDDED_MAX_TOKENS = 4096;

function hasApiKeyHeader(req: FastifyRequest): boolean {
  const v = req.headers['x-api-key'];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.length > 0;
}

/**
 * 北京时间「今天零点」的 epoch 毫秒。
 *
 * 配额按北京时间滚动不是偏爱国内用户，而是运营者（我们）的账单日就是北京时间 ——
 * 「今天花了多少」必须和人对账单的直觉一致，否则配额页面永远差 8 小时。
 */
function beijingDayStart(now = Date.now()): number {
  const BJ_OFFSET_MS = 8 * 3_600_000;
  return Math.floor((now + BJ_OFFSET_MS) / 86_400_000) * 86_400_000 - BJ_OFFSET_MS;
}

/* ────────────────────────── 工具 ────────────────────────── */

/**
 * 估算 token 数（上游没给 usage 时的兜底）。
 *
 * 口径刻意保守且简单：ASCII 按 4 字符 ≈ 1 token，其余（中日韩、全角、emoji）
 * 按 1.5 字符 ≈ 1 token —— 这是 DeepSeek / GPT 系列公开口径里最接近的近似。
 * 估算值只用于「账单不至于整条丢失」，真正计费以上游 usage 为准。
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) ascii += 1;
    else if (cp <= 0xffff) wide += 1;
    // 超出 BMP 的（emoji 等）按 2 个宽字符计
    else wide += 2;
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide / 1.5));
}

function toMicros(tokens: number, priceCnyPerMillion: number): number {
  // 元 = tokens / 1e6 × price；微元 = tokens × price。整数乘法，不引入浮点误差。
  return Math.round(tokens * priceCnyPerMillion);
}

/** SSE 单行的解析：`data: xxx` → payload；空行 / 注释行 / 非 data 行返回 null。 */
function parseSseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trim();
}

/* ────────────────────────── 模块注册 ────────────────────────── */

const ChatBody = Type.Object({
  app: Type.Optional(Type.String({ maxLength: 64 })),
  model: Type.String({ minLength: 1, maxLength: 64 }),
  messages: Type.Array(
    Type.Object({
      role: Type.String({ minLength: 1, maxLength: 32 }),
      /**
       * content 允许两种形态：
       * - 纯文本（绝大多数请求）
       * - OpenAI 多模态数组（V4.1 Flash 的图片输入：[{type:'text'},{type:'image_url'}]）
       * 数组形态不设长度上限 —— base64 图片会撑爆任何合理的字符数限制，
       * 真正的体量控制靠 bodyLimit。
       */
      content: Type.Union([
        Type.String({ minLength: 1, maxLength: 100_000 }),
        Type.Array(Type.Any()),
        Type.Null(),
      ]),
      /**
       * ⚠️ Fastify 的 AJV 默认 removeAdditional: true —— schema 没声明的字段
       * 会在校验时被静默剥掉。function calling 第二轮的 tool_calls /
       * tool_call_id、思考模型的 reasoning_content 回传，必须在 schema 里
       * 显式放行，否则上游收到残缺消息报 422（且错误信息极具误导性）。
       */
      tool_calls: Type.Optional(Type.Array(Type.Any())),
      tool_call_id: Type.Optional(Type.String({ maxLength: 128 })),
      reasoning_content: Type.Optional(Type.String({ maxLength: 200_000 })),
      name: Type.Optional(Type.String({ maxLength: 128 })),
    }),
    { minItems: 1, maxItems: 200 },
  ),
  stream: Type.Optional(Type.Boolean()),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  /** function calling 工具清单与选择策略，原样透传上游（客户端自担工具语义） */
  tools: Type.Optional(Type.Array(Type.Any())),
  tool_choice: Type.Optional(Type.Any()),
  /**
   * 上限放宽到 1_000_000 是**故意的**：schema 校验跑在 preHandler（embedded 判定）之前，
   * 若在这里卡 32_000，内置通道的 max_tokens=100000 会在进 handler 前就被 400 掉，
   * 「强制压到 4096」永远轮不到执行。真正的上限在 handler 里按身份分别施加：
   * embedded → 4096（截断）；带 Key → 32_000（超过报 400，维持既有行为）。
   */
  max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
});

const UsageQuery = Type.Object({
  app: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  groupBy: Type.Optional(Type.Union([Type.Literal('day'), Type.Literal('app'), Type.Literal('model')])),
  detail: Type.Optional(Type.Union([Type.Literal('0'), Type.Literal('1'), Type.Integer()])),
});

export async function registerAi(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db, config } = opts;
  const recorder = new UsageRecorder(db, config.AI_USAGE_FLUSH_INTERVAL_MS);

  /** 单价缓存：避免每次请求都查表；管理员改价后由 invalidate 失效。 */
  const priceCache = new Map<string, { priceIn: number; priceOut: number }>();
  function invalidatePriceCache(): void {
    priceCache.clear();
  }

  /** 首次启动预置模型目录（已存在则不动，保留管理员改过的价）。 */
  const seedModels = (): void => {
    const now = Date.now();
    for (const m of SEED_MODELS) {
      const existing = db.select().from(aiModelPrices).where(eq(aiModelPrices.model, m.model)).get();
      if (existing) continue;
      db.insert(aiModelPrices).values({
        model: m.model,
        label: m.label,
        context: m.context,
        priceInCnyPerMillion: m.priceIn,
        priceOutCnyPerMillion: m.priceOut,
        updatedAt: now,
      }).run();
    }
  };
  seedModels();

  recorder.start();
  app.addHook('onClose', async () => {
    recorder.stop();
  });

  function getPrice(model: string): { priceIn: number; priceOut: number } {
    const cached = priceCache.get(model);
    if (cached) return cached;
    const row = db.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).get();
    const price = row
      ? { priceIn: row.priceInCnyPerMillion, priceOut: row.priceOutCnyPerMillion }
      : { priceIn: 0, priceOut: 0 };
    priceCache.set(model, price);
    return price;
  }

  /* ──────────────────── 内置通道：白名单 / 配额 ──────────────────── */

  /** 进程启动时解析一次。空数组 = 内置通道整体关闭。 */
  const embeddedSlugs = config.AI_EMBEDDED_APPS.split(',').map((s) => s.trim()).filter(Boolean);

  /**
   * slug → appId。任何失败（没传 / 不在白名单 / 白名单里有但 apps 表没有）统一返回 null，
   * 调用方一律回 **401 + 固定文案「未授权」** —— 不区分「app 不存在」和「未开放内置通道」，
   * 否则攻击者可以用错误信息逐个探测哪些 app 开了白名单。
   */
  function resolveEmbeddedSlug(slug: string | undefined): string | null {
    if (!slug || embeddedSlugs.length === 0) return null;
    if (!embeddedSlugs.includes(slug)) return null;
    const row = db.select({ id: apps.id }).from(apps).where(eq(apps.slug, slug)).get();
    return row?.id ?? null;
  }

  /**
   * 该 app 今天（北京时间）内置通道已用 token 数。
   *
   * 口径：只统计 `keyId='embedded'` 的行 —— 带 Key 的调用是已认证流量，
   * 有自己的信任等级和限流，不该占用「匿名通道」的配额。
   * 注意这里是「事后账」：用量经队列落库（默认 1s 延迟），并发请求可能小幅超额 ——
   * 对防滥用足够，精确性由带 Key 路径保证。
   */
  function embeddedTokensUsedToday(appId: string): number {
    const row = db
      .select({ used: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)` })
      .from(aiUsage)
      .where(and(eq(aiUsage.appId, appId), eq(aiUsage.keyId, 'embedded'), gte(aiUsage.createdAt, beijingDayStart())))
      .get();
    return row?.used ?? 0;
  }

  /**
   * 无 Key 请求的 chat 鉴权：白名单 + IP 限流 + 日配额，三关全过才放行。
   * 通过后 `req.ctx` 与 APIKey 请求形状一致（appId/keyId 都有），
   * 下游记账、用量查询不需要知道流量来自哪条通道。
   */
  function authorizeEmbeddedChat(req: FastifyRequest): void {
    const body = req.body as AiChatRequest | undefined;
    const appId = resolveEmbeddedSlug(body?.app);
    if (appId === null) throw new AppError('UNAUTHORIZED', '未授权');

    // 限流按 IP+slug 分桶：无 Key 请求没有可信身份，IP 是唯一抓手；
    // 桶键带 slug 是为了「同一 IP 上多个内置 app」不互相挤占。
    const bucket = `embedded:${req.ip}:${body!.app}`;
    const hits = hitAiLimit(bucket, config.AI_EMBEDDED_RATE_LIMIT_MAX, EMBEDDED_WINDOW_MS);
    if (hits > config.AI_EMBEDDED_RATE_LIMIT_MAX) {
      throw new AppError('RATE_LIMITED', `内置通道每分钟最多 ${config.AI_EMBEDDED_RATE_LIMIT_MAX} 次`, {
        limit: config.AI_EMBEDDED_RATE_LIMIT_MAX,
        windowMs: EMBEDDED_WINDOW_MS,
      });
    }

    const used = embeddedTokensUsedToday(appId);
    if (used >= config.AI_EMBEDDED_DAILY_TOKENS) {
      throw new AppError('AI_QUOTA_EXCEEDED', `今日 token 配额已用尽（${config.AI_EMBEDDED_DAILY_TOKENS}/天）`, {
        limit: config.AI_EMBEDDED_DAILY_TOKENS,
        used,
        resetAt: beijingDayStart() + 86_400_000,
      });
    }

    req.ctx = { authType: 'embedded', appId, keyId: 'embedded', scopes: ['ai:chat'] };
  }

  /** 无 Key 请求的 usage 鉴权：必须显式带 `?app=<白名单 slug>`，只能看自己 app 的聚合。 */
  function authorizeEmbeddedUsage(req: FastifyRequest): void {
    const q = req.query as { app?: string };
    const appId = resolveEmbeddedSlug(q.app);
    if (appId === null) throw new AppError('UNAUTHORIZED', '未授权');
    req.ctx = { authType: 'embedded', appId, keyId: 'embedded', scopes: ['ai:read'] };
  }

  /* ════════════════════════════════════════════════════════════════
     POST /v1/ai/chat/completions —— 流式代理
     ════════════════════════════════════════════════════════════════ */
  const requireChatKey = app.requireApiKey({ scopes: ['ai:chat'] });
  app.post(
    '/v1/ai/chat/completions',
    {
      preHandler: [
        acceptBearerApiKey,
        /**
         * 双通道分派：无 Key 走 embedded 白名单；有 Key 走原有 `requireApiKey` 路径
         * （同一个插件函数，从数组挪进分派器，行为不变）。不能把 `requireApiKey`
         * 留在数组里 —— 它对无 Key 请求抛 401，embedded 分支永远轮不到。
         */
        async (req: FastifyRequest, reply) => {
          if (!hasApiKeyHeader(req)) {
            authorizeEmbeddedChat(req);
            return;
          }
          await requireChatKey(req, reply);
          // 带 Key：按 app 限流（既有行为）
          const hits = hitAiLimit(req.ctx.appId!, config.AI_RATE_LIMIT_MAX, config.AI_RATE_LIMIT_WINDOW_MS);
          if (hits > config.AI_RATE_LIMIT_MAX) {
            throw new AppError('RATE_LIMITED', `AI 调用过于频繁：每 ${config.AI_RATE_LIMIT_WINDOW_MS / 1000} 秒最多 ${config.AI_RATE_LIMIT_MAX} 次`, {
              limit: config.AI_RATE_LIMIT_MAX,
              windowMs: config.AI_RATE_LIMIT_WINDOW_MS,
            });
          }
        },
      ],
      schema: { body: ChatBody },
      // 多模态：base64 图片会超过 Fastify 默认 1MiB（客户端已压缩，双保险）
      bodyLimit: 12 * 1024 * 1024,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as AiChatRequest;

      if (config.DEEPSEEK_API_KEY === '') {
        throw new AppError('AI_DISABLED');
      }
      if (!(ALLOWED_MODELS as readonly string[]).includes(body.model)) {
        throw new AppError('AI_MODEL_NOT_ALLOWED', `模型 ${body.model} 未开放`, { allowed: ALLOWED_MODELS });
      }

      // max_tokens 按身份分别施加上限（schema 已放宽到 1_000_000，原因见 ChatBody 注释）：
      // - embedded：**截断到 4096**，不报错 —— 匿名端调用方不该被要求了解我们的内部上限
      // - 带 Key：超 32_000 报 400，维持既有行为
      if (body.max_tokens !== undefined && body.max_tokens > EMBEDDED_MAX_TOKENS) {
        if (req.ctx.authType === 'embedded') {
          body.max_tokens = EMBEDDED_MAX_TOKENS;
        } else if (body.max_tokens > 32_000) {
          throw new AppError('VALIDATION', 'max_tokens 超过上限 32000', { field: 'max_tokens', max: 32_000 });
        }
      }

      const startedAt = Date.now();
      const promptChars = body.messages.map((m) => m.content).join('');

      // 上游请求体：只透传白名单字段，避免客户端塞进 temperature 之外的怪东西
      const upstreamBody = {
        model: body.model,
        /**
         * AJV 的 coerceTypes（'array' 模式）会把 content: null 矫正成空串或空数组
         * （取决于 Union 分支匹配顺序），而 DeepSeek 的 assistant 工具消息要求
         * content 为 null —— 收到 ""/[] 会 422。这里统一还原。
         */
        messages: body.messages.map((m) =>
          m.content == null || m.content === '' || (Array.isArray(m.content) && m.content.length === 0)
            ? { ...m, content: null }
            : m,
        ),
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        // function calling：工具清单与选择策略原样透传
        tools: body.tools,
        tool_choice: body.tool_choice,
        stream: true,
        // 关键：没有它 DeepSeek 不会在流末尾附 usage，我们就只能全靠估算
        stream_options: { include_usage: true },
      };

      // TODO(ai-debug): 临时排查 —— 打印发往上游的原始 body 前 900 字符，定位后删除
      console.log('[ai:debug] upstream body:', JSON.stringify(upstreamBody).slice(0, 900));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.AI_UPSTREAM_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await fetch(`${config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        const code = err instanceof Error && err.name === 'AbortError' ? 'AI_UPSTREAM_TIMEOUT' : 'AI_UPSTREAM_UNREACHABLE';
        recordUsage({
          appId: req.ctx.appId!,
          keyId: req.ctx.keyId!,
          model: body.model,
          promptTokens: 0,
          completionTokens: 0,
          costMicros: 0,
          latencyMs: Date.now() - startedAt,
          status: 'error',
          errorCode: code,
        });
        throw new AppError('AI_UPSTREAM_ERROR', `上游不可达：${err instanceof Error ? err.message : String(err)}`, { code });
      }

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        clearTimeout(timeout);
        recordUsage({
          appId: req.ctx.appId!,
          keyId: req.ctx.keyId!,
          model: body.model,
          promptTokens: 0,
          completionTokens: 0,
          costMicros: 0,
          latencyMs: Date.now() - startedAt,
          status: 'error',
          errorCode: 'AI_UPSTREAM_ERROR',
        });
        throw new AppError('AI_UPSTREAM_ERROR', `上游返回 ${upstream.status}`, {
          upstreamStatus: upstream.status,
          upstreamBody: text.slice(0, 500),
        });
      }

      // ---- 响应头：SSE ----
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 关掉 nginx 缓冲，否则增量会被攒成一坨最后一次性吐出，流式就没了
        'x-accel-buffering': 'no',
      });

      let clientGone = false;
      const onClientClose = (): void => {
        clientGone = true;
        // 客户端走了就别再往上游写数据：上游继续生成也是白花钱
        controller.abort();
      };
      req.raw.on('close', onClientClose);
      reply.raw.on('close', onClientClose);

      let completionText = '';
      let upstreamUsage: UpstreamChunk['usage'] = null;
      let pending = ''; // 跨 chunk 的半行缓冲

      const writeFrame = (payload: unknown): void => {
        if (clientGone || reply.raw.writableEnded) return;
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          if (clientGone) break;
          pending += decoder.decode(chunk, { stream: true });

          // SSE 以空行分帧；最后一行可能不完整，留在 pending 里等下一块
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';

          for (const line of lines) {
            const data = parseSseLine(line);
            if (data === null) continue;

            if (data === '[DONE]') {
              // 扣住上游的 [DONE]：收尾时由我们自己发，保证它排在 usage 帧之后
              // （见文件头第 1 条）。
              continue;
            }

            let parsed: UpstreamChunk;
            try {
              parsed = JSON.parse(data) as UpstreamChunk;
            } catch {
              continue; // 上游偶发的非 JSON 心跳行，忽略
            }

            if (parsed.usage) {
              // 上游的 usage 帧**不转发**，只留数。理由：它的字段形状与契约不一致 ——
              // 只有 prompt/completion/total，缺 `cost_cny`，而客户端整帧读。
              // 原样转发等于让「上游给不给 usage」决定了「客户端能不能拿到成本」。
              // 收尾时由我们统一发一帧完整的。
              upstreamUsage = parsed.usage;
              continue;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') completionText += delta;

            // 转发增量帧（choices 非空的那类）
            writeFrame(parsed);
          }
        }
      } catch (err) {
        // 上游读流出错：客户端还连着就直接把错误以 SSE 帧的形式补出去
        if (!clientGone) {
          writeFrame({ error: { code: 'AI_UPSTREAM_ERROR', message: err instanceof Error ? err.message : String(err) } });
        }
      } finally {
        clearTimeout(timeout);
        req.raw.off('close', onClientClose);
        reply.raw.off('close', onClientClose);
      }

      // ---- 补 usage 帧 ----
      const promptTokens = upstreamUsage?.prompt_tokens ?? estimateTokens(promptChars);
      const completionTokens = upstreamUsage?.completion_tokens ?? estimateTokens(completionText);
      const totalTokens = upstreamUsage?.total_tokens ?? promptTokens + completionTokens;
      const price = getPrice(body.model);
      const costMicros = toMicros(promptTokens, price.priceIn) + toMicros(completionTokens, price.priceOut);

      const status: 'ok' | 'aborted' = clientGone ? 'aborted' : 'ok';
      if (!clientGone) {
        // usage 帧一律由我们发（上游那帧已被丢弃）：客户端靠它判定流结束，
        // 并且契约要求它带 cost_cny。
        writeFrame({
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            cost_cny: costMicros / 1_000_000,
          },
        });
        // [DONE] 一律由这里发（上游那一条在上面被扣住了）。
        // 曾经写成 `if (!sawDone)` —— 结果是「上游发了 [DONE] 就永远不补」，
        // 客户端会一直等下去。这正是「扣住再统一发尾」的必然后果，别改回去。
        reply.raw.write('data: [DONE]\n\n');
        if (!reply.raw.writableEnded) reply.raw.end();
      }

      // ---- 记账（客户端断开也要记）----
      recordUsage({
        appId: req.ctx.appId!,
        keyId: req.ctx.keyId!,
        model: body.model,
        promptTokens,
        completionTokens,
        costMicros,
        latencyMs: Date.now() - startedAt,
        status,
        errorCode: null,
      });

      return reply;
    },
  );

  function recordUsage(row: Omit<PendingUsage, 'id' | 'totalTokens' | 'createdAt'>): void {
    recorder.push({
      ...row,
      id: newId(),
      totalTokens: row.promptTokens + row.completionTokens,
      createdAt: Date.now(),
    });
  }

  /* ════════════════════════════════════════════════════════════════
     GET /v1/ai/usage —— 用量聚合
     ════════════════════════════════════════════════════════════════ */
  const requireUsageKey = app.requireApiKey({ scopes: ['ai:read'] });
  app.get(
    '/v1/ai/usage',
    {
      preHandler: [
        acceptBearerApiKey,
        /** 双通道分派：无 Key 走 embedded（必须显式带 `?app=<白名单 slug>`）；有 Key 走原有路径。 */
        async (req: FastifyRequest, reply) => {
          if (!hasApiKeyHeader(req)) {
            authorizeEmbeddedUsage(req);
            return;
          }
          await requireUsageKey(req, reply);
        },
      ],
      schema: { querystring: UsageQuery },
    },
    async (req: FastifyRequest) => {
      const q = req.query as {
        app?: string;
        from?: string;
        to?: string;
        groupBy?: AiUsageGroupBy;
        detail?: string | number;
      };
      const groupBy: AiUsageGroupBy = q.groupBy ?? 'day';

      const from = q.from ? Date.parse(q.from) : NaN;
      const to = q.to ? Date.parse(q.to) : NaN;
      if (q.from && Number.isNaN(from)) throw new AppError('VALIDATION', `from 不是合法的 ISO 时间：${q.from}`);
      if (q.to && Number.isNaN(to)) throw new AppError('VALIDATION', `to 不是合法的 ISO 时间：${q.to}`);

      // 多租户红线：用量**永远**按调用方 Key 所属的 app 过滤。
      // 不这么做，任何一把带 ai:read 的 Key 都能读到全平台账单 ——
      // 而「按 app 分账」正是这个模块存在的意义。
      const callerAppId = req.ctx.appId!;
      const conditions = [eq(aiUsage.appId, callerAppId)];
      if (Number.isFinite(from)) conditions.push(gte(aiUsage.createdAt, from));
      if (Number.isFinite(to)) conditions.push(lte(aiUsage.createdAt, to));

      if (q.app) {
        // `app` 传 slug 或 id 都认（调用方往往只知道 slug），但必须解析到**自己**的 app，
        // 否则就是拿自己的 Key 查别人家的账。
        const bySlug = db.select({ id: apps.id }).from(apps).where(eq(apps.slug, q.app)).get();
        const resolved = bySlug?.id ?? q.app;
        if (resolved !== callerAppId) {
          throw new AppError('FORBIDDEN', '只能查询本 Key 所属应用的用量');
        }
      }

      const where = and(...conditions);

      // 分组表达式：day 用本地时区还是 UTC？统一用 UTC+8 之外的中性做法 ——
      // 这里按 UTC 计算并在返回时保持原样，避免跨时区服务器把「今天」算错一天。
      const keyExpr =
        groupBy === 'day'
          ? sql<string>`strftime('%Y-%m-%d', ${aiUsage.createdAt} / 1000, 'unixepoch')`
          : groupBy === 'app'
            ? sql<string>`${aiUsage.appId}`
            : sql<string>`${aiUsage.model}`;

      const rows = db
        .select({
          key: keyExpr,
          requests: sql<number>`count(*)`,
          promptTokens: sql<number>`coalesce(sum(${aiUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`coalesce(sum(${aiUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)`,
          costCny: sql<number>`coalesce(sum(${aiUsage.costCny}), 0)`,
        })
        .from(aiUsage)
        .where(where)
        .groupBy(keyExpr)
        .orderBy(asc(keyExpr))
        .all();

      const total = rows.reduce(
        (acc, r) => ({
          requests: acc.requests + r.requests,
          prompt_tokens: acc.prompt_tokens + r.promptTokens,
          completion_tokens: acc.completion_tokens + r.completionTokens,
          total_tokens: acc.total_tokens + r.totalTokens,
          cost_cny: acc.cost_cny + r.costCny,
        }),
        { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_cny: 0 },
      );

      const payload: AiUsageResponse = {
        total,
        items: rows.map((r) => ({
          key: r.key,
          requests: r.requests,
          prompt_tokens: r.promptTokens,
          completion_tokens: r.completionTokens,
          total_tokens: r.totalTokens,
          // 金额统一保留 6 位小数（微元精度），避免消费方看到 1.0000000000000002
          cost_cny: Math.round(r.costCny * 1_000_000) / 1_000_000,
        })),
      };

      if (String(q.detail ?? '') === '1') {
        // 明细（哪把 Key、延迟多少、错误码）只给真 Key 看：embedded 的调用方是匿名客户端，
        // 给它明细等于把 app 的内部运营数据摊给任何人。
        if (req.ctx.authType === 'embedded') {
          throw new AppError('FORBIDDEN', '内置通道只支持聚合用量，不支持明细查询');
        }
        const detailRows = db
          .select()
          .from(aiUsage)
          .where(where)
          .orderBy(desc(aiUsage.createdAt))
          .limit(50)
          .all();
        payload.requests = detailRows.map((r) => ({
          id: r.id,
          app: r.appId,
          key_id: r.keyId,
          model: r.model,
          prompt_tokens: r.promptTokens,
          completion_tokens: r.completionTokens,
          total_tokens: r.totalTokens,
          cost_cny: Math.round(r.costCny * 1_000_000) / 1_000_000,
          latency_ms: r.latencyMs,
          status: r.status,
          error_code: r.errorCode,
          created_at: r.createdAt,
        }));
      }

      return payload;
    },
  );

  /* ════════════════════════════════════════════════════════════════
     GET /v1/ai/models —— 模型目录与单价
     ════════════════════════════════════════════════════════════════ */
  app.get(
    '/v1/ai/models',
    { preHandler: [acceptBearerApiKey, app.requireApiKey({ scopes: ['ai:read'] })] },
    async () => {
      const rows = db.select().from(aiModelPrices).where(inArray(aiModelPrices.model, [...ALLOWED_MODELS])).all();
      return {
        items: rows.map((r) => ({
          id: r.model,
          label: r.label,
          context: r.context,
          price_in_cny_per_million: r.priceInCnyPerMillion,
          price_out_cny_per_million: r.priceOutCnyPerMillion,
        })),
      };
    },
  );

  /* ════════════════════════════════════════════════════════════════
     PATCH /v1/ai/models/:model —— 管理员调价（Master Key）
     ════════════════════════════════════════════════════════════════ */
  app.patch(
    '/v1/ai/models/:model',
    {
      preHandler: [app.requireMaster()],
      schema: {
        body: Type.Object({
          price_in_cny_per_million: Type.Optional(Type.Number({ minimum: 0 })),
          price_out_cny_per_million: Type.Optional(Type.Number({ minimum: 0 })),
        }),
      },
    },
    async (req) => {
      const model = (req.params as { model: string }).model;
      const body = req.body as { price_in_cny_per_million?: number; price_out_cny_per_million?: number };

      if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
        throw new AppError('AI_MODEL_NOT_ALLOWED', `模型 ${model} 未开放`, { allowed: ALLOWED_MODELS });
      }
      if (body.price_in_cny_per_million === undefined && body.price_out_cny_per_million === undefined) {
        throw new AppError('VALIDATION', '没有要修改的价格字段');
      }

      const patch: Partial<typeof aiModelPrices.$inferInsert> = { updatedAt: Date.now() };
      if (body.price_in_cny_per_million !== undefined) patch.priceInCnyPerMillion = body.price_in_cny_per_million;
      if (body.price_out_cny_per_million !== undefined) patch.priceOutCnyPerMillion = body.price_out_cny_per_million;

      db.update(aiModelPrices).set(patch).where(eq(aiModelPrices.model, model)).run();
      // 价变了必须让缓存失效，否则新价要等进程重启才生效
      invalidatePriceCache();

      const row = db.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).get();
      return {
        id: row!.model,
        label: row!.label,
        context: row!.context,
        price_in_cny_per_million: row!.priceInCnyPerMillion,
        price_out_cny_per_million: row!.priceOutCnyPerMillion,
      };
    },
  );
}
