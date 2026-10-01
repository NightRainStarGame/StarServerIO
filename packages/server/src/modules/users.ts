import { Type } from '@sinclair/typebox';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, type UserPublic } from '@ssio/shared';
import { users } from '../db/schema.js';
import { NullableString } from '../schema/common.js';
import type { ModuleOptions } from '../types.js';

const UserPublicSchema = Type.Object({
  id: Type.String(),
  appId: Type.String(),
  username: Type.String(),
  nickname: Type.String(),
  avatarFileId: NullableString(),
  status: Type.Union([Type.Literal('active'), Type.Literal('banned')]),
  createdAt: Type.Number(),
});

/**
 * 用户资料查询（供消费方展示昵称头像）。
 *
 * **不返回手机号/邮箱** —— 这是给「任意登录用户可见」的接口，泄露联系方式属于个人信息越权。
 */
export async function registerUsers(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { db } = opts;

  app.get(
    '/v1/users/:id',
    {
      preHandler: [app.requireApiKey({ scopes: ['users:read'] })],
      schema: { response: { 200: UserPublicSchema } },
    },
    async (req): Promise<UserPublic> => {
      const id = (req.params as { id: string }).id;
      // 强制带上 appId：跨应用查用户一律 404（不返回 403，避免泄露「该用户在别处存在」）
      const row = db
        .select()
        .from(users)
        .where(and(eq(users.id, id), eq(users.appId, req.ctx.appId!)))
        .get();
      if (!row) throw new AppError('NOT_FOUND', '用户不存在');

      return {
        id: row.id,
        appId: row.appId,
        username: row.username,
        nickname: row.nickname,
        avatarFileId: row.avatarFileId,
        status: row.status,
        createdAt: row.createdAt,
      };
    },
  );
}
