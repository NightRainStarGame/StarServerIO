/**
 * 由系统 Node（而非 Electron）运行的种子子进程。
 *
 * 为什么拆出去：better-sqlite3 是按 Node ABI 编译的原生模块，
 * Electron 的 ABI（NODE_MODULE_VERSION 130）与 Node 22（127）不同，
 * 在 Electron 主进程里直接 load 会 ERR_DLOPEN_FAILED。
 * 服务端本来就该是独立进程 —— 这里顺带成了架构演示。
 *
 * 起一个真实 SSIO + 发布 1.3.0"安装包"，然后把连接信息打到 stdout：
 *   READY <baseUrl> <apiKey>
 */
/* eslint-disable no-console */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configForTest, openDatabase, runMigrations, buildApp } from '@ssio/server/embed';
import { createNodeClient } from '@ssio/node';

const dataDir = mkdtempSync(join(tmpdir(), 'ssio-emin-'));
const config = configForTest({ dataDir, LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '100000' });
const { db, sqlite: _sqlite } = openDatabase(join(dataDir, 'ssio.db'));
runMigrations(db);
const server = await buildApp({ db, config });
await server.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${server.server.address().port}`;

const master = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'X-Master-Key': config.MASTER_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
};

const created = await master('POST', '/v1/apps', { slug: 'electron-min', name: 'Electron 示例' });
const key = await master('POST', '/v1/keys', {
  appId: created.id,
  name: 'dev',
  scopes: ['storage:read', 'storage:write', 'release:read', 'release:write'],
});

// 8 MB 的"安装包"，发布为 1.3.0
const client = createNodeClient({ baseUrl: base, apiKey: key.key });
const chunk = 4 * 1024 * 1024;
const size = 8 * 1024 * 1024;
const init = await client.files.initUpload({ filename: 'MyApp-Setup.exe', totalSize: size, chunkSize: chunk });
const hash = createHash('sha256');
for (let i = 0; i < init.totalChunks; i++) {
  const buf = randomBytes(Math.min(chunk, size - i * chunk));
  hash.update(buf);
  await client.files.putChunk(init.uploadId, i, buf);
}
const done = await client.files.complete(init.uploadId, { sha256: hash.digest('hex') });
await client.releases.create({
  channel: 'stable', platform: 'win', arch: 'x64',
  version: '1.3.0', fileId: done.fileId, notesMd: '修复更新链路，提升下载稳定性。', published: true,
});

console.log(`READY ${base} ${key.key}`);
// 保持进程活着：SSIO 服务端要一直可访问
setInterval(() => {}, 1 << 30);
