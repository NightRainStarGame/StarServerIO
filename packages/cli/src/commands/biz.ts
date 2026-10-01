import { writeFileSync } from 'node:fs';
import type { ReleaseRecord } from '@ssio/shared';
import type { Ctx } from '../client.js';
import type { Out } from '../format.js';
import type { Flags } from '../parse.js';
import { uploadFile } from '../upload.js';

/** APIKey 通道的业务命令：发版、发卡、公告、配额。 */

function str(flags: Flags, key: string): string {
  const v = flags[key];
  return typeof v === 'string' ? v : '';
}

function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  return v === undefined || typeof v !== 'string' ? undefined : Number(v);
}

export async function releasePublish(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const slug = str(flags, 'app');
  const file = str(flags, 'file');
  const version = str(flags, 'version');
  if (!slug || !file || !version) {
    throw new Error('用法：ssio release publish --app <slug> --version <x.y.z> --file <path> [--channel stable] [--platform win32] [--arch x64]');
  }

  const { client } = await ctx.appClient(slug);
  const up = await uploadFile(client, file, {
    onProgress: (done, total) => out.info(`  上传分片 ${done}/${total}`),
  });

  const release = await client.releases.create({
    version,
    // platform 的合法值是 win | linux | android | any（不是 win32 —— 那是 Electron 的叫法）
    channel: (str(flags, 'channel') || 'stable') as ReleaseRecord['channel'],
    platform: (str(flags, 'platform') || 'win') as ReleaseRecord['platform'],
    arch: (str(flags, 'arch') || 'x64') as ReleaseRecord['arch'],
    fileId: up.fileId,
    notesMd: str(flags, 'notes') || null,
    mandatory: flags.mandatory === true,
    minVersion: str(flags, 'min-version') || null,
    rolloutPercent: num(flags, 'rollout'),
    published: flags.draft !== true,
  });

  out.info(
    `已发布 ${release.version}（${release.channel}/${release.platform}/${release.arch}）` +
      `${up.dedup ? ' [秒传]' : ''} ${Math.round(up.sizeBytes / 1024)} KB，耗时 ${up.elapsedMs} ms`,
  );
  out.json(release);
}

export async function releaseList(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const { client } = await ctx.appClient(str(flags, 'app'));
  const list = await client.releases.list({ channel: str(flags, 'channel') || undefined });
  out.table(
    ['id', '版本', '渠道', '平台', '架构', '灰度', '强制', '发布'],
    list.map((r) => [
      r.id,
      r.version,
      r.channel,
      r.platform,
      r.arch,
      `${r.rolloutPercent}%`,
      r.mandatory ? '是' : '否',
      r.published ? '已发布' : '草稿',
    ]),
  );
}

export async function releaseYank(ctx: Ctx, out: Out, args: string[], flags: Flags): Promise<void> {
  const id = args[0];
  if (!id) throw new Error('用法：ssio release yank <releaseId>');
  const { client } = await ctx.appClient(str(flags, 'app'));
  await client.releases.remove(id);
  out.info(`已下架：${id}`);
}

export async function releaseLatest(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const { client } = await ctx.appClient(str(flags, 'app'));
  const res = await client.releases.latest({
    platform: str(flags, 'platform') || 'win',
    channel: (str(flags, 'channel') || 'stable') as ReleaseRecord['channel'],
    current: str(flags, 'current') || undefined,
    arch: str(flags, 'arch') || undefined,
    clientId: str(flags, 'client-id') || undefined,
  });
  out.json(res);
}

export async function cardBatch(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const slug = str(flags, 'app');
  const total = num(flags, 'total') ?? 100;
  if (!slug) throw new Error('用法：ssio card batch --app <slug> [--total 100] [--days 30] [--prefix X]');
  const { app } = await ctx.appClient(slug);

  const days = num(flags, 'days');
  const payloadRaw = str(flags, 'payload');
  // Master 通道必须显式带 ?appId=（APIKey 通道才从凭据里推断）
  const batch = await ctx.master().masterRequest<{ id: string; name: string; exportUrl: string }>(
    'POST',
    '/v1/cards/batches',
    {
      name: str(flags, 'name') || `batch-${Date.now()}`,
      total,
      prefix: str(flags, 'prefix') || undefined,
      payload: payloadRaw ? (JSON.parse(payloadRaw) as Record<string, unknown>) : days ? { days } : null,
      expiresAt: days ? Date.now() + days * 86_400_000 : null,
    },
    { appId: app.id },
  );
  out.info(`批次已生成：${batch.id}（${total} 张）`);
  out.info(`一次性导出链接（导出即销毁）：${batch.exportUrl}`);
  out.json(batch);
}

export async function cardExport(ctx: Ctx, out: Out, args: string[], flags: Flags): Promise<void> {
  const batchId = args[0];
  const dest = str(flags, 'out');
  if (!batchId || !dest) throw new Error('用法：ssio card export <batchId> --out cards.csv');
  // 直接用管理员凭据取：端点返回的是 text/csv 明文（一次性，取完即销毁密文）
  const csv = await ctx.master().masterRequest<string>('GET', `/v1/cards/batches/${batchId}/export`);
  writeFileSync(dest, csv, 'utf8');
  out.info(`已导出 ${csv.trim().split('\n').length} 行 → ${dest}`);
}

export async function announcePost(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const title = str(flags, 'title');
  const contentMd = str(flags, 'content-md');
  if (!title || !contentMd) throw new Error('用法：ssio announce post --title <标题> --content-md <markdown> [--pinned]');
  const { client } = await ctx.appClient(str(flags, 'app'));
  const a = await client.announcements.create({
    title,
    contentMd,
    pinned: flags.pinned === true,
    level: (str(flags, 'level') || 'info') as 'info',
    startAt: num(flags, 'start-at'),
    endAt: num(flags, 'end-at') ?? null,
  });
  out.info(`公告已发布：${a.id}`);
  out.json(a);
}

export async function announceList(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const { client } = await ctx.appClient(str(flags, 'app'));
  const list = flags.active === true ? await client.announcements.active() : await client.announcements.list();
  out.table(
    ['id', '标题', '级别', '置顶', '生效', '结束'],
    list.map((a) => [
      a.id,
      a.title,
      a.level,
      a.pinned ? '是' : '否',
      new Date(a.startAt).toISOString().slice(0, 10),
      a.endAt ? new Date(a.endAt).toISOString().slice(0, 10) : '-',
    ]),
  );
}

export async function quotaShow(ctx: Ctx, out: Out, flags: Flags): Promise<void> {
  const { client } = await ctx.appClient(str(flags, 'app'));
  const q = await client.files.quota();
  out.table(
    ['已用(MB)', '配额(MB)', '占比'],
    [
      [
        (q.usedBytes / 1024 / 1024).toFixed(2),
        (q.quotaBytes / 1024 / 1024).toFixed(2),
        `${((q.usedBytes / q.quotaBytes) * 100).toFixed(1)}%`,
      ],
    ],
  );
}
