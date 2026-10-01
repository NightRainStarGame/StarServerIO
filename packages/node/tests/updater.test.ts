import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configForTest, openDatabase, runMigrations, buildApp } from '@ssio/server/embed';
import { SsioError } from '@ssio/core';
import { createNodeClient, createUpdater, downloadToFile, verifyFile } from '../src/index.js';

/**
 * 打真实服务端（@ssio/server 的 buildApp + 真实端口 + 真实 SQLite）。
 * 下载/续传/校验是 P4 验收的第 5、6 条。
 */

const MB = 1024 * 1024;
const tmp = mkdtempSync(join(tmpdir(), 'ssio-node-'));

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let masterKey: string;
let apiKey: string;
let bigFile: { fileId: string; sha256: string; url: string; size: number };

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ssio-node-db-'));
  const config = configForTest({ dataDir, LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '100000' });
  const { db, sqlite: _sqlite } = openDatabase(join(dataDir, 'ssio.db'));
  runMigrations(db);
  app = await buildApp({ db, config });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  masterKey = config.MASTER_KEY;

  // 建应用 + 全 scope Key（master 通道走 HTTP）
  const appRec = await callJson('POST', '/v1/apps', { 'X-Master-Key': masterKey }, { slug: 'node-sdk', name: 'Node SDK 测试' });
  const keyRec = await callJson(
    'POST',
    '/v1/keys',
    { 'X-Master-Key': masterKey },
    { appId: appRec.id, name: 'test', scopes: ['storage:read', 'storage:write', 'release:read', 'release:write'] },
  );
  apiKey = keyRec.key as string;

  // 传 50 MB（13 片 × 4MB）并发布为 2.0.0
  const client = createNodeClient({ baseUrl, apiKey });
  const size = 50 * MB;
  const chunkSize = 4 * MB;
  const init = await client.files.initUpload({ filename: 'TaskManager-Setup.exe', totalSize: size, chunkSize });
  const hash = createHash('sha256');
  for (let i = 0; i < init.totalChunks; i++) {
    const len = Math.min(chunkSize, size - i * chunkSize);
    const buf = randomBytes(len);
    hash.update(buf);
    await client.files.putChunk(init.uploadId, i, buf);
  }
  const sha256 = hash.digest('hex');
  const done = await client.files.complete(init.uploadId, { sha256 });

  const rel = await client.releases.create({
    channel: 'stable',
    platform: 'win',
    arch: 'x64',
    version: '2.0.0',
    fileId: done.fileId,
    notesMd: 'P4 验收版本',
    published: true,
  });
  const latest = await client.releases.latest({ platform: 'win', channel: 'stable', arch: 'x64', current: '1.0.0', clientId: 'device-001' });
  bigFile = { fileId: done.fileId, sha256, url: latest.url as string, size };
  void rel;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function callJson(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

describe('updater 全链路（真实服务端）', () => {
  it('check → download → 文件 sha256 与服务端一致', async () => {
    const client = createNodeClient({ baseUrl, apiKey });
    const upd = createUpdater(client, {
      app: 'taskmanager',
      platform: 'win',
      arch: 'x64',
      channel: 'stable',
      currentVersion: '1.0.0',
      clientId: 'device-001',
      downloadDirDefault: tmp,
    });

    const info = await upd.check();
    expect(info.hasUpdate).toBe(true);
    expect(info.version).toBe('2.0.0');
    expect(info.sha256).toBe(bigFile.sha256);

    const dest = await upd.download(info);
    expect(statSync(dest).size).toBe(50 * MB);
    // 落盘内容 hash 与服务端记录一致
    const got = createHash('sha256').update(await readFile(dest)).digest('hex');
    expect(got).toBe(bigFile.sha256);

    expect(await upd.verify(info, dest)).toBe(true);
  }, 60_000);

  it('断点续传：残留 .part 触发 Range 请求，完成时间明显短于整下', async () => {
    const dest = join(tmp, 'resume.bin');
    const part = `${dest}.part`;

    // 手工模拟「下到一半断了」：只取前 25 MB 写进 .part
    const half = await fetch(bigFile.url, { headers: { Range: `bytes=0-${25 * MB - 1}` } });
    await pipeline(Readable.fromWeb(half.body as import('node:stream/web').ReadableStream), createWriteStream(part));
    expect(statSync(part).size).toBe(25 * MB);

    // 记录后续请求头，验证续传真的走 Range
    const seen: Array<Record<string, string>> = [];
    const recordingFetch: typeof globalThis.fetch = (url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return globalThis.fetch(url, init);
    };

    const t0 = Date.now();
    await downloadToFile(bigFile.url, dest, { expectedSha256: bigFile.sha256, fetchImpl: recordingFetch });
    const resumedMs = Date.now() - t0;

    expect(seen[0]!.Range).toBe(`bytes=${25 * MB}-`); // ⭐ 续传从断点开始
    expect(statSync(dest).size).toBe(50 * MB);

    // 对照组：整下同一文件
    const full = join(tmp, 'full.bin');
    const t1 = Date.now();
    await downloadToFile(bigFile.url, full, { expectedSha256: bigFile.sha256 });
    const fullMs = Date.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`[bench] 续传 25MB 断点: ${resumedMs} ms vs 整下 50MB: ${fullMs} ms`);
    expect(resumedMs).toBeLessThan(fullMs * 0.9);
  }, 120_000);

  it('篡改 sha256 → verify 抛错且本地文件被删除', async () => {
    const dest = join(tmp, 'tamper.bin');
    await downloadToFile(bigFile.url, dest, { expectedSha256: bigFile.sha256 });
    expect(statSync(dest).size).toBe(50 * MB);

    await expect(verifyFile(dest, 'f'.repeat(64))).rejects.toSatisfy((e: unknown) => e instanceof SsioError && e.code === 'CHECKSUM_MISMATCH');
    // ⭐ 坏文件不能留在用户磁盘上冒充安装包（statSync 是同步的，用 flag 断言）
    expect(fileExists(dest)).toBe(false);
  }, 60_000);

  it('expectedSha256 错误 → 自动整包重下 2 次后抛错，不留坏文件', async () => {
    const dest = join(tmp, 'badsha.bin');
    await expect(downloadToFile(bigFile.url, dest, { expectedSha256: '0'.repeat(64) })).rejects.toSatisfy(
      (e: unknown) => e instanceof SsioError && e.code === 'CHECKSUM_MISMATCH',
    );
    expect(fileExists(dest)).toBe(false);
    expect(fileExists(`${dest}.part`)).toBe(false);
  }, 180_000);

  it('apply 默认不执行安装（autoInstall=false），manual 策略只回路径', async () => {
    const client = createNodeClient({ baseUrl, apiKey });
    const upd = createUpdater(client, { platform: 'win', arch: 'x64', currentVersion: '1.0.0' });
    const info = await upd.check();

    const manual = await upd.apply({ strategy: 'manual', autoInstall: true }, join(tmp, 'x.exe'));
    expect(manual.applied).toBe(false);

    // installer 策略但没确认 → 仍然不执行
    const cautious = await upd.apply({ strategy: 'installer' }, join(tmp, 'x.exe'));
    expect(cautious.applied).toBe(false);
    expect(cautious.message).toContain('autoInstall');
    void info;
  });
});
