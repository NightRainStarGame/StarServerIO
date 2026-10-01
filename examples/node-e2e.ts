/**
 * SSIO 全链路冒烟：登录 → 上传文件 → 发布版本 → 拉更新 → 下载 → 校验 sha256 → 发卡 → 核销。
 *
 * 跑法（仓库根）：
 *   pnpm build && node --experimental-strip-types examples/node-e2e.ts
 *
 * 之所以先 build：Node 的 type stripping 只处理 .ts 本身，不会把 import 里的
 * `./x.js` 映射到 `./x.ts`，所以这里直接引编译产物 `dist/*.js`（真实存在的文件）。
 *
 * 它起一个**真实的**服务端（临时目录 + 真实 SQLite + 真实 HTTP 端口），
 * 全程只走 HTTP —— 和真实客户端的视角完全一致，不直接调内部函数。
 */
// 示例脚本的 stdout 就是它的产物，console.log 是必需品
/* eslint-disable no-console */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configForTest } from '../packages/server/dist/env.js';
import { openDatabase } from '../packages/server/dist/db/client.js';
import { runMigrations } from '../packages/server/dist/db/migrate.js';
import { buildApp } from '../packages/server/dist/app.js';

const startedAll = Date.now();
const dataDir = mkdtempSync(join(tmpdir(), 'ssio-e2e-'));

function log(msg: string): void {
  console.log(msg);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  log(`  [step] ${name.padEnd(24, ' ')} ${String(Date.now() - t0).padStart(6)} ms`);
  return out;
}

async function main(): Promise<void> {
  const config = configForTest({ dataDir, LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '10000' });
  const { db, sqlite } = openDatabase(join(dataDir, 'ssio.db'));
  runMigrations(db);

  const app = await buildApp({ db, config });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  log(`\nSSIO 全链路冒烟  (${base})\n${'-'.repeat(52)}`);

  type Json = Record<string, unknown>;
  async function call(
    method: string,
    path: string,
    opts: { master?: boolean; key?: string; bearer?: string; body?: unknown; raw?: Buffer } = {},
  ): Promise<{ status: number; json: Json; text: string; buffer: Buffer }> {
    const headers: Record<string, string> = {};
    if (opts.master) headers['X-Master-Key'] = config.MASTER_KEY;
    if (opts.key) headers['X-API-Key'] = opts.key;
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers['Content-Type'] = 'application/octet-stream';
      body = opts.raw;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = {};
    }
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return { status: res.status, json, text, buffer };
  }

  // 1. 建应用 + 签发 APIKey
  const created = await step('创建应用', () =>
    call('POST', '/v1/apps', { master: true, body: { slug: 'e2e-app', name: 'E2E 演示应用' } }),
  );
  const appId = created.json.id as string;

  const key = await step('签发 APIKey', () =>
    call('POST', '/v1/keys', {
      master: true,
      body: {
        appId,
        name: 'e2e',
        scopes: ['storage:read', 'storage:write', 'release:read', 'release:write', 'cards:redeem', 'announcements:read', 'announcements:write'],
      },
    }),
  );
  const apiKey = key.json.key as string;

  // 2. 注册 + 登录（用户通道）
  const username = `u${Date.now()}`;
  await step('注册用户', () =>
    call('POST', '/v1/auth/register', { key: apiKey, body: { username, password: 'P@ssw0rd-123', nickname: '豆芽' } }),
  );
  const login = await step('用户登录', () =>
    call('POST', '/v1/auth/login', { key: apiKey, body: { username, password: 'P@ssw0rd-123' } }),
  );
  const accessToken = (login.json as { accessToken?: string }).accessToken ?? '';

  // 3. 分片上传 12 MB（3 片 × 4 MB）
  const chunkSize = 4 * 1024 * 1024;
  const totalSize = 12 * 1024 * 1024;
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  for (let i = 0; i < 3; i++) {
    const buf = randomBytes(chunkSize);
    chunks.push(buf);
    hash.update(buf);
  }
  const localSha = hash.digest('hex');

  const init = await step('初始化上传', () =>
    call('POST', '/v1/storage/uploads', { key: apiKey, body: { filename: 'TaskManager-Setup.exe', totalSize, chunkSize } }),
  );
  const uploadId = init.json.uploadId as string;

  await step('上传 3 个分片', async () => {
    for (let i = 0; i < chunks.length; i++) {
      await call('PUT', `/v1/storage/uploads/${uploadId}/chunks/${i}`, { key: apiKey, raw: chunks[i]! });
    }
    return true;
  });

  const done = await step('合并并校验 sha256', () =>
    call('POST', `/v1/storage/uploads/${uploadId}/complete`, { key: apiKey, body: { sha256: localSha } }),
  );
  const fileId = done.json.fileId as string;
  const serverSha = done.json.sha256 as string;
  if (serverSha !== localSha) throw new Error(`sha256 不一致：本地 ${localSha} / 服务端 ${serverSha}`);

  // 4. 发布版本
  const rel = await step('创建发行版本', () =>
    call('POST', '/v1/releases', {
      key: apiKey,
      body: { channel: 'stable', platform: 'win', arch: 'x64', version: '1.3.0', fileId, notesMd: '修复更新链路', published: true },
    }),
  );

  // 5. 客户端拉更新
  const latest = await step('客户端查询更新', () =>
    call('GET', `/v1/releases/latest?platform=win&channel=stable&arch=x64&current=1.2.9&clientId=device-001`, { key: apiKey }),
  );
  if (!latest.json.hasUpdate) throw new Error('应检出更新');
  const updateUrl = latest.json.url as string;

  // 6. 真下载 + 校验
  await step('下载并校验 sha256', async () => {
    const res = await fetch(updateUrl, { headers: { Range: 'bytes=0-' } });
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== localSha) throw new Error(`下载内容 sha256 不一致：${got}`);
    if (buf.length !== totalSize) throw new Error(`下载长度不符：${buf.length} != ${totalSize}`);
    return true;
  });

  // 7. 发卡 + 一次性导出
  const batch = await step('生成 50 张卡密', () =>
    call('POST', `/v1/cards/batches?appId=${appId}`, { master: true, body: { name: '月卡', total: 50, payload: { days: 30 } } }),
  );
  const exportUrl = batch.json.exportUrl as string;

  const csv = await step('导出明文 CSV', async () => {
    const res = await fetch(`${base}${exportUrl}`);
    return res.text();
  });
  const firstCode = csv.trim().split('\n')[1]!;

  // 8. 用户通道核销 + 幂等复核
  const redeem1 = await step('用户核销卡密', () =>
    call('POST', '/v1/cards/redeem', { bearer: accessToken, body: { code: firstCode } }),
  );
  const redeem2 = await step('重复核销（幂等）', () =>
    call('POST', '/v1/cards/redeem', { bearer: accessToken, body: { code: firstCode } }),
  );

  // 9. 公告
  await step('发布公告并读取', async () => {
    await call('POST', '/v1/announcements', {
      key: apiKey,
      body: { title: 'v1.3.0 已发布', contentMd: '修复更新链路', level: 'info', pinned: true },
    });
    const active = await call('GET', '/v1/announcements/active', { key: apiKey });
    if ((active.json as unknown as Array<unknown>).length === 0) throw new Error('公告未生效');
    return true;
  });

  log(`${'-'.repeat(52)}`);
  log(`  版本: ${rel.json.version}  大小: ${rel.json.sizeBytes} 字节  sha256: ${serverSha.slice(0, 16)}…`);
  log(`  更新检出: ${latest.json.hasUpdate ? '有' : '无'} → ${latest.json.version as string}  强制: ${String(latest.json.mandatory)}`);
  log(`  卡密: ${firstCode}  首次核销: ${String(redeem1.json.redeemed)}  复核: ${String(redeem2.json.redeemed)}  权益: ${JSON.stringify(redeem1.json.payload)}`);
  log(`  全链路耗时: ${Date.now() - startedAll} ms\n`);

  await app.close();
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error('\n[E2E 失败]', err instanceof Error ? err.message : err);
  process.exit(1);
});
