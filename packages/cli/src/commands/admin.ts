import type { AppRecord } from '@ssio/shared';
import { createClient, type SsioClient } from '@ssio/core';
import { mask, saveConfig } from '../config.js';
import type { Ctx } from '../client.js';
import type { Out } from '../format.js';
import type { Flags } from '../parse.js';

/** Master 通道的管理面命令：配置、应用、APIKey。 */

function str(flags: Flags, key: string): string {
  const v = flags[key];
  return typeof v === 'string' ? v : '';
}

export async function configSet(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  if (flags.url) ctx.config.url = String(flags.url);
  if (flags['master-key']) ctx.config.masterKey = String(flags['master-key']);
  saveConfig(ctx.config);
  out.info(`配置已写入（${ctx.url} / Master Key ${mask(ctx.config.masterKey)}）`);
}

export async function configShow(ctx: Ctx, out: Out): Promise<void> {
  out.table(
    ['项', '值'],
    [
      ['url', ctx.url],
      ['masterKey', mask(ctx.config.masterKey)],
      ['已配置应用', Object.keys(ctx.config.apps).join(', ') || '(无)'],
    ],
  );
}

export async function appList(ctx: Ctx, out: Out): Promise<void> {
  const apps = await ctx.master().masterRequest<AppRecord[]>('GET', '/v1/apps');
  out.table(
    ['id', 'slug', '名称', '配额(MB)', '创建时间'],
    apps.map((a) => [
      a.id,
      a.slug,
      a.name,
      String(Math.round(a.quotaBytes / 1024 / 1024)),
      new Date(a.createdAt).toISOString().slice(0, 19).replace('T', ' '),
    ]),
  );
}

export async function appCreate(ctx: Ctx, out: Out, args: string[], flags: Flags): Promise<void> {
  const slug = args[0];
  if (!slug) throw new Error('用法：ssio app create <slug> [--name <名称>] [--quota-mb <n>]');
  const body: Record<string, unknown> = { slug, name: str(flags, 'name') || slug };
  if (flags['quota-mb']) body.quotaBytes = Math.round(Number(flags['quota-mb']) * 1024 * 1024);

  const app = await ctx.master().masterRequest<AppRecord>('POST', '/v1/apps', body);
  out.info(`应用已创建：${app.slug} (${app.id})`);
  out.json(app);
}

export async function keyIssue(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const slug = str(flags, 'app');
  if (!slug) throw new Error('用法：ssio key issue --app <slug> --scopes a,b [--name <名称>]');
  const scopes = str(flags, 'scopes')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) throw new Error('至少给一个 scope');

  let appId = ctx.config.apps[slug]?.appId;
  if (!appId) {
    const apps = await ctx.master().masterRequest<AppRecord[]>('GET', '/v1/apps');
    const found = apps.find((a) => a.slug === slug);
    if (!found) throw new Error(`应用不存在：${slug}`);
    appId = found.id;
  }

  const res = await ctx
    .master()
    .masterRequest<{ key: string; id: string }>('POST', '/v1/keys', { appId, name: str(flags, 'name') || 'cli', scopes });

  // 默认写进配置：后续业务命令就不用手抄 Key 了（--no-save 关闭）
  if (flags['no-save'] !== true) {
    ctx.config.apps[slug] = { appId, apiKey: res.key };
    saveConfig(ctx.config);
  }
  out.info(`APIKey 已签发（${res.id}）${flags['no-save'] === true ? '' : '，已写入配置'}`);
  out.json({ id: res.id, key: res.key, scopes });
}

export async function keyList(ctx: Ctx, out: Out): Promise<void> {
  const keys = await ctx.master().masterRequest<Array<Record<string, unknown>>>('GET', '/v1/keys');
  out.table(
    ['id', 'name', 'appId', 'scopes', '过期'],
    keys.map((k) => [
      String(k.id ?? ''),
      String(k.name ?? ''),
      String(k.appId ?? ''),
      Array.isArray(k.scopes) ? (k.scopes as string[]).join(',') : '',
      k.expiresAt ? new Date(Number(k.expiresAt)).toISOString().slice(0, 10) : '-',
    ]),
  );
}

export async function keyRevoke(ctx: Ctx, out: Out, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error('用法：ssio key revoke <keyId>');
  await ctx.master().masterRequest('DELETE', `/v1/keys/${id}`);
  out.info(`Key 已吊销：${id}`);
}

/**
 * 调整已签发 Key 的 scope（不改明文，客户端不需要换 Key）。
 *
 * 存在意义：权限模型细化时（把 delete 从 write 里拆出来），老 Key 会突然缺权限，
 * 而吊销重签意味着所有已分发的客户端都要更新 —— 这条命令是避免那种代价的迁移通道。
 */
export async function keyScopes(ctx: Ctx, out: Out, args: string[], flags: Flags): Promise<void> {
  const id = args[0];
  if (!id) throw new Error('用法：ssio key scopes <keyId> --scopes a,b [--name <名称>]');
  const raw = str(flags, 'scopes');
  const name = str(flags, 'name');
  if (!raw && !name) throw new Error('至少给 --scopes 或 --name 之一');

  const body: Record<string, unknown> = {};
  if (raw) {
    const scopes = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (scopes.length === 0) throw new Error('--scopes 为空');
    body.scopes = scopes;
  }
  if (name) body.name = name;

  const res = await ctx.master().masterRequest<{ id: string; scopes: string[]; masked: string }>(
    'PATCH',
    `/v1/keys/${id}`,
    body,
  );
  out.info(`Key 已更新：${res.masked} (${res.id})`);
  out.json(res);
}

/** 供测试与其它命令复用：拿一个「只带指定 scope」的一次性 client。 */
export function ephemeralClient(url: string, apiKey: string): SsioClient {
  return createClient({ baseUrl: url, apiKey });
}
