import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@ssio/shared';
import { apps } from '../db/schema.js';
import type { ModuleOptions } from '../types.js';
import { VERSION } from '../version.js';

const startedAt = Date.now();

export async function registerHealth(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  app.get(
    '/v1/healthz',
    {
      schema: {
        response: {
          200: Type.Object({
            ok: Type.Literal(true),
            version: Type.String(),
            uptime: Type.Number(),
          }),
        },
      },
    },
    async () => ({ ok: true as const, version: VERSION, uptime: Date.now() - startedAt }),
  );

  app.get(
    '/v1/readyz',
    {
      schema: {
        response: {
          200: Type.Object({ ok: Type.Literal(true), db: Type.Literal(true) }),
        },
      },
    },
    async () => {
      try {
        // 真查一次库：能连上且表存在才算就绪，供 Caddy / systemd 做健康检查
        opts.db.select({ id: apps.id }).from(apps).limit(1).all();
      } catch (e) {
        throw new AppError('INTERNAL', '数据库不可用', { reason: (e as Error).message });
      }
      return { ok: true as const, db: true as const };
    },
  );
}
