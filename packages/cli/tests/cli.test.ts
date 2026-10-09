import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, configForTest, openDatabase, runMigrations } from '@ssio/server/embed';
import * as admin from '../src/commands/admin.js';
import * as biz from '../src/commands/biz.js';
import { createCtx } from '../src/client.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { createOut } from '../src/format.js';
import type { Flags } from '../src/parse.js';

/**
 * CLI 端到端：真实服务端 + 真实 HTTP + 真实文件系统（临时目录）。
 *
 * 不走 spawn 子进程：命令处理函数本身就是可测单元，直接调用更快也更稳；
 * 输出从 out.lines 读，副作用从服务端与磁盘上验。
 */

const tmp = mkdtempSync(join(tmpdir(), 'ssio-cli-'));
const SLUG = 'cli-app';
let app: Awaited<ReturnType<typeof buildApp>>;
let masterKey: string;
let ctx: ReturnType<typeof createCtx>;

function flags(input: Record<string, string | boolean> = {}): Flags {
  return input;
}

function newOut() {
  return createOut(false);
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ssio-cli-db-'));
  const config = configForTest({ dataDir, LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '100000' });
  const { db } = openDatabase(join(dataDir, 'ssio.db'));
  runMigrations(db);
  app = await buildApp({ db, config });
  await app.listen({ host: '127.0.0.1', port: 0 });
  masterKey = config.MASTER_KEY;

  // 配置落在临时目录，绝不碰真实 ~/.ssio
  process.env.SSIO_CONFIG = join(tmp, 'config.json');
  process.env.SSIO_URL = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  process.env.SSIO_MASTER_KEY = masterKey;
  saveConfig({ url: process.env.SSIO_URL, masterKey, apps: {} });
  ctx = createCtx(loadConfig());
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('ssio CLI', () => {
  it('app create + list：应用真的建出来了', async () => {
    const out = newOut();
    await admin.appCreate(ctx, out, [SLUG], flags({ name: 'CLI 测试应用' }));
    expect(out.lines.join('\n')).toContain(SLUG);

    const listOut = newOut();
    await admin.appList(ctx, listOut);
    expect(listOut.lines.join('\n')).toContain(SLUG);
  });

  it('key issue：签发后写进配置，后续业务命令直接复用', async () => {
    const out = newOut();
    await admin.keyIssue(ctx, out, flags({ app: SLUG, scopes: 'release:read,release:write,storage:read,storage:write,announcements:write,announcements:read' }));
    expect(out.lines.join('\n')).toContain('APIKey 已签发');

    const cfg = loadConfig();
    expect(cfg.apps[SLUG]?.apiKey).toBeTruthy();
    // 重新建 ctx：让后续命令拿到刚写入的 key
    ctx = createCtx(loadConfig());
  });

  it('release publish：上传 2MB 包并建版本', async () => {
    const pkg = join(tmp, 'Setup-1.0.0.exe');
    writeFileSync(pkg, Buffer.alloc(2 * 1024 * 1024, 7));
    const sha = createHash('sha256').update(readFileSync(pkg)).digest('hex');

    const out = newOut();
    await biz.releasePublish(ctx, out, flags({ app: SLUG, version: '1.0.0', file: pkg, channel: 'stable', platform: 'win', arch: 'x64' }));
    const text = out.lines.join('\n');
    expect(text).toContain('已发布 1.0.0');

    // 服务端侧：版本存在且 sha256 与本地文件一致
    const { client } = await ctx.appClient(SLUG);
    const list = await client.releases.list();
    expect(list.map((r) => r.version)).toContain('1.0.0');
    const rec = list.find((r) => r.version === '1.0.0')!;
    expect(rec.sha256).toBe(sha);
  }, 30_000);

  it('release latest + list：客户端视角能检出更新', async () => {
    const { client } = await ctx.appClient(SLUG);
    // platform 用 win（不是 Electron 的 win32）；arch 不传时服务端按 any 匹配，
    // 而发布的版本 arch=x64，所以这里必须显式传，否则匹配不上
    const latest = await client.releases.latest({ platform: 'win', arch: 'x64', channel: 'stable', current: '0.9.0' });
    expect(latest.hasUpdate).toBe(true);

    const out = newOut();
    await biz.releaseList(ctx, out, flags({ app: SLUG }));
    expect(out.lines.join('\n')).toContain('1.0.0');
  });

  it('card batch + export：生成 50 张并导出 CSV（一次性）', async () => {
    const out = newOut();
    await biz.cardBatch(ctx, out, flags({ app: SLUG, total: '50', days: '30' }));
    const text = out.lines.join('\n');
    expect(text).toContain('批次已生成');
    // id 后面紧跟中文括号，\S+ 会把「（50」一起吞进去，这里只取 id 字符
    const batchId = /批次已生成：([A-Za-z0-9_-]+)/.exec(text)?.[1];
    expect(batchId).toBeTruthy();

    const csvPath = join(tmp, 'cards.csv');
    const expOut = newOut();
    await biz.cardExport(ctx, expOut, [batchId!], flags({ out: csvPath }));
    const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
    // 首行是表头 code，后面 50 张
    expect(lines.length).toBe(51);

    // 一次性：再导一次必须失败
    await expect(biz.cardExport(ctx, newOut(), [batchId!], flags({ out: join(tmp, 'again.csv') }))).rejects.toThrow();
  }, 30_000);

  it('announce post + list：公告能发能读', async () => {
    const out = newOut();
    await biz.announcePost(ctx, out, flags({ app: SLUG, title: '停服维护', 'content-md': '今晚 24:00 维护' }));
    expect(out.lines.join('\n')).toContain('公告已发布');

    const listOut = newOut();
    await biz.announceList(ctx, listOut, flags({ app: SLUG }));
    expect(listOut.lines.join('\n')).toContain('停服维护');
  });

  it('quota：能看到已用与配额', async () => {
    const out = newOut();
    await biz.quotaShow(ctx, out, flags({ app: SLUG }));
    expect(out.lines.join('\n')).toMatch(/已用\(MB\)/);
  });

  it('key scopes：改权限不动明文（旧 Key 迁移升级用）', async () => {
    const before = await ctx.master().masterRequest<Array<{ id: string; scopes: string[]; masked: string }>>(
      'GET',
      '/v1/keys',
    );
    const target = before.find((k) => (k.scopes ?? []).includes('release:write'))!;
    expect(target.scopes).not.toContain('release:delete');

    const out = newOut();
    await admin.keyScopes(ctx, out, [target.id], flags({ scopes: 'release:read,release:write,release:delete' }));
    expect(out.lines.join('\n')).toContain('Key 已更新');

    const after = await ctx.master().masterRequest<Array<{ id: string; scopes: string[]; masked: string }>>(
      'GET',
      '/v1/keys',
    );
    const row = after.find((k) => k.id === target.id)!;
    expect(row.scopes).toContain('release:delete');
    // 掩码不变 = 还是同一把 Key，客户端无需更换
    expect(row.masked).toBe(target.masked);
  });

  it('key revoke：吊销后原 Key 不再可用', async () => {
    const keys = await ctx.master().masterRequest<Array<{ id: string }>>('GET', '/v1/keys');
    const id = keys[0]!.id;
    await admin.keyRevoke(ctx, newOut(), [id]);
    const after = await ctx.master().masterRequest<Array<{ id: string; revokedAt?: number | null }>>('GET', '/v1/keys');
    expect(after.find((k) => k.id === id)?.revokedAt ?? null).not.toBeNull();
  });
});
