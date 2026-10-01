/**
 * SSIO 全链路冒烟（SDK 版）：登录 → 上传 → 发版 → 拉更新 → 下载 → 校验 → 发卡 → 核销 → 公告。
 *
 * 跑法（仓库根）：
 *   pnpm build && pnpm example:e2e
 *
 * 业务面全部走 @ssio/node（等价于真实客户端）；只有「建应用/签发 Key/发卡批次」
 * 这类 Master 管理面保留裸 fetch —— SDK 刻意不提供管理端能力，避免它被打进
 * 客户端包后诱导调用方把 Master Key 带进发行版。
 */
/* eslint-disable no-console */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configForTest, openDatabase, runMigrations, buildApp } from '../packages/server/dist/embed.js';
import { createNodeClient, createUpdater } from '@ssio/node';

const startedAll = Date.now();
const dataDir = mkdtempSync(join(tmpdir(), 'ssio-e2e-'));
const downloadDir = mkdtempSync(join(tmpdir(), 'ssio-e2e-dl-'));

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
  log(`\nSSIO 全链路冒烟·SDK 版  (${base})\n${'-'.repeat(52)}`);

  /** Master 管理面（SDK 不提供） */
  async function master<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'X-Master-Key': config.MASTER_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T;
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}`);
    return json;
  }

  // 1. 管理面：建应用 + 签发 Key + 发卡批次
  const created = await step('创建应用（管理面）', () => master<{ id: string }>('POST', '/v1/apps', { slug: 'e2e-app', name: 'E2E 演示' }));
  const key = await step('签发 APIKey（管理面）', () =>
    master<{ key: string }>('POST', '/v1/keys', {
      appId: created.id,
      name: 'e2e',
      scopes: ['storage:read', 'storage:write', 'release:read', 'release:write', 'cards:redeem', 'announcements:read', 'announcements:write'],
    }),
  );

  // 2. SDK 客户端：从这里开始等价于真实接入方
  const client = createNodeClient({ baseUrl: base, apiKey: key.key, tokenFile: join(dataDir, 'tokens.json') });

  const username = `u${Date.now()}`;
  await step('注册用户（SDK）', () => client.auth.register({ username, password: 'P@ssw0rd-123', nickname: '豆芽' }));
  const _login = await step('用户登录（SDK）', () => client.auth.login({ username, password: 'P@ssw0rd-123' }));
  log(`         登录态已写入 ${join(dataDir, 'tokens.json')}（tokenFile 持久化）`);

  // 3. 分片上传 12 MB（3 × 4MB）
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

  const init = await step('初始化上传（SDK）', () =>
    client.files.initUpload({ filename: 'TaskManager-Setup.exe', totalSize, chunkSize }),
  );
  await step('上传 3 个分片（SDK）', async () => {
    for (let i = 0; i < chunks.length; i++) await client.files.putChunk(init.uploadId, i, chunks[i]!);
    return true;
  });
  const done = await step('合并并校验 sha256（SDK）', () => client.files.complete(init.uploadId, { sha256: localSha }));

  // 4. 发布 1.3.0 并以 1.2.9 的身份拉更新
  await step('创建并发布版本（SDK）', async () => {
    const rel = await client.releases.create({
      channel: 'stable', platform: 'win', arch: 'x64', version: '1.3.0',
      fileId: done.fileId, notesMd: '修复更新链路', published: true,
    });
    return rel;
  });

  const upd = createUpdater(client, {
    app: 'taskmanager', platform: 'win', arch: 'x64', channel: 'stable',
    currentVersion: '1.2.9', clientId: 'device-e2e', downloadDirDefault: downloadDir,
  });
  const info = await step('updater.check（SDK）', () => upd.check());
  if (!info.hasUpdate) throw new Error('应检出更新');

  const dest = await step('updater.download（SDK）', () => upd.download(info));
  await step('updater.verify（SDK）', () => upd.verify(info, dest));
  if (statSync(dest).size !== totalSize) throw new Error('下载文件大小不符');

  // 5. 发卡（管理面）→ 导出 → 用户通道核销（SDK，幂等）
  const batch = await step('生成 50 张卡密（管理面）', () =>
    master<{ exportUrl: string; generatedInMs: number }>('POST', `/v1/cards/batches?appId=${created.id}`, {
      name: '月卡', total: 50, payload: { days: 30 },
    }),
  );
  const csv = await step('导出明文 CSV（管理面）', async () => {
    const res = await fetch(base + batch.exportUrl);
    return res.text();
  });
  const firstCode = csv.trim().split('\n')[1]!;

  const redeem1 = await step('用户核销卡密（SDK）', () => client.cards.redeem({ code: firstCode }));
  const redeem2 = await step('重复核销·幂等（SDK）', () => client.cards.redeem({ code: firstCode }));

  // 6. 公告
  await step('发布公告并读取（SDK）', async () => {
    await client.announcements.create({ title: 'v1.3.0 已发布', contentMd: '修复更新链路', pinned: true });
    const active = await client.announcements.active();
    if (active.length === 0) throw new Error('公告未生效');
    return active;
  });

  log(`${'-'.repeat(52)}`);
  log(`  更新检出: ${info.version}  大小: ${info.size} 字节  强制: ${String(info.mandatory)}`);
  log(`  下载落盘: ${dest}`);
  log(`  sha256: ${done.sha256.slice(0, 16)}…（客户端预计算 == 服务端 == 落盘三方一致）`);
  log(`  卡密: ${firstCode.slice(0, 4)}-****-${firstCode.slice(-4)}  首次核销: ${String(redeem1.redeemed)}  复核: ${String(redeem2.redeemed)}  权益: ${JSON.stringify(redeem1.payload)}`);
  log(`  全链路耗时: ${Date.now() - startedAll} ms\n`);

  await app.close();
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(downloadDir, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error('\n[E2E 失败]', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
