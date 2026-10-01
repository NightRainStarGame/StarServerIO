import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { hashApiKey } from '../lib/keys.js';
import type { ServerConfig } from '../env.js';

/**
 * 按「应用」限流，而不是只按 IP。
 *
 * 只按 IP 会让同一个 NAT 出口的多个客户端互相拖垮；按 appId/Key 分桶才符合多租户语义。
 * 未带 Key 的匿名请求退化为按 IP 限流。
 */
export async function registerRateLimit(app: FastifyInstance, config: ServerConfig): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => {
      const raw = req.headers['x-api-key'];
      const key = Array.isArray(raw) ? raw[0] : raw;
      return typeof key === 'string' && key.length > 0 ? `key:${hashApiKey(key).slice(0, 16)}` : `ip:${req.ip}`;
    },
  });
}
