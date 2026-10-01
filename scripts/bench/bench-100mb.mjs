/**
 * 100 MB 分片上传基准：服务端跑在**独立进程**，父进程只做客户端。
 *
 * 跑法（仓库根，需先 build）：
 *   pnpm build && node scripts/bench/bench-100mb.mjs
 *
 * 为什么不用 vitest 里那个用例的数字：那里客户端与服务端同进程，
 * 客户端自己持有的 100 MB 会混进 RSS，读出来偏高且不可归因。
 */
/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHUNKS = Number(process.env.BENCH_CHUNKS ?? 25);
const CHUNK_SIZE = Number(process.env.BENCH_CHUNK_SIZE ?? 4 * 1024 * 1024);
const TOTAL = CHUNKS * CHUNK_SIZE;

const child = spawn(process.execPath, ['server-child.mjs'], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });

let peakRss = 0;
let peakHeap = 0;
let peakExternal = 0;
let baselineRss = 0;
const readyPromise = new Promise((resolve) => {
  let done = false;
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) {
      const t = line.trim();
      if (t.startsWith('READY ') && !done) {
        done = true;
        const [, port, masterKey] = t.split(' ');
        resolve({ port: Number(port), masterKey });
      } else if (t.startsWith('MEM ')) {
        const [, rss, heap, ext] = t.split(' ');
        peakRss = Math.max(peakRss, Number(rss));
        peakHeap = Math.max(peakHeap, Number(heap));
        peakExternal = Math.max(peakExternal, Number(ext));
      }
    }
  });
});
child.stderr.on('data', (b) => process.stderr.write(b));

const { port, masterKey } = await readyPromise;
const base = `http://127.0.0.1:${port}`;

async function call(method, path, { master, key, body, raw } = {}) {
  const headers = {};
  if (master) headers['X-Master-Key'] = masterKey;
  if (key) headers['X-API-Key'] = key;
  let payload;
  if (raw) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const appRec = await call('POST', '/v1/apps', { master: true, body: { slug: 'bench-app', name: 'bench' } });
const keyRec = await call('POST', '/v1/keys', {
  master: true,
  body: { appId: appRec.id, name: 'bench', scopes: ['storage:read', 'storage:write'] },
});
const apiKey = keyRec.key;

await new Promise((r) => setTimeout(r, 400));
baselineRss = peakRss;

const init = await call('POST', '/v1/storage/uploads', {
  key: apiKey,
  body: { filename: 'bench.bin', totalSize: TOTAL, chunkSize: CHUNK_SIZE },
});

const hash = createHash('sha256');
const started = Date.now();
for (let i = 0; i < CHUNKS; i++) {
  const buf = randomBytes(CHUNK_SIZE); // 逐片生成并立即发送，父进程不堆积
  hash.update(buf);
  await call('PUT', `/v1/storage/uploads/${init.uploadId}/chunks/${i}`, { key: apiKey, raw: buf });
}
const uploadMs = Date.now() - started;

const completeStart = Date.now();
const done = await call('POST', `/v1/storage/uploads/${init.uploadId}/complete`, {
  key: apiKey,
  body: { sha256: hash.digest('hex') },
});
const completeMs = Date.now() - completeStart;

await new Promise((r) => setTimeout(r, 300));
child.kill('SIGTERM');

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log('');
console.log(`${(TOTAL / 1024 / 1024).toFixed(0)} MB 分片上传（${CHUNKS} × ${(CHUNK_SIZE / 1024 / 1024).toFixed(0)} MB，服务端独立进程）`);
console.log(`  上传分片:              ${uploadMs} ms  (${mb((TOTAL / uploadMs) * 1000)} MB/s)`);
console.log(`  合并 + sha256:         ${completeMs} ms`);
console.log(`  端到端:                ${uploadMs + completeMs} ms`);
console.log(`  服务端基线 RSS:        ${mb(baselineRss)} MB`);
console.log(`  服务端峰值 RSS:        ${mb(peakRss)} MB（增量 ${mb(peakRss - baselineRss)} MB）`);
console.log(`  服务端峰值 heapUsed:   ${mb(peakHeap)} MB`);
console.log(`  服务端峰值 external:   ${mb(peakExternal)} MB`);
console.log(`  落盘:                  ${done.sizeBytes} 字节  sha256 ${done.sha256.slice(0, 16)}…`);
