// 注意：`declare module 'fastify'` 内部可直接使用该模块自己的类型名，
// 因此这里只导入 FastifyReply（导入 FastifyRequest 会被判定为未使用）
import type { FastifyReply } from 'fastify';
import type { Db } from './db/client.js';
import type { ServerConfig } from './env.js';

/** 一次请求的认证上下文，由鉴权插件写入。 */
export interface RequestContext {
  authType: 'anonymous' | 'apikey' | 'user' | 'master';
  appId?: string;
  keyId?: string;
  scopes: string[];
  userId?: string;
}

export interface ModuleOptions {
  db: Db;
  config: ServerConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }

  interface FastifyInstance {
    /** 校验 `X-API-Key`，可选校验 scope 集合。 */
    requireApiKey: (opts?: { scopes?: string[] }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** 校验 `Authorization: Bearer <access token>`。 */
    requireUser: () => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** 校验 `X-Master-Key`，仅用于 /v1/apps 与 /v1/keys 的写操作。 */
    requireMaster: () => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
