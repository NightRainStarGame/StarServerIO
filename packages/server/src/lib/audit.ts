import type { Db } from '../db/client.js';
import { auditLogs } from '../db/schema.js';
import { newId } from '../db/client.js';

/**
 * 审计日志。
 *
 * 只记录「谁对什么做了什么」，**不记录**密钥明文、卡密明文、密码。
 * ip / userAgent 属于个人信息，留存策略见 docs/05-安全说明.md。
 */
export interface AuditInput {
  appId?: string | null;
  actorType: 'master' | 'apikey' | 'user' | 'system';
  actorId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

export function writeAudit(db: Db, input: AuditInput): void {
  db.insert(auditLogs)
    .values({
      id: newId(),
      appId: input.appId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      target: input.target ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      meta: input.meta ?? null,
      createdAt: Date.now(),
    })
    .run();
}
