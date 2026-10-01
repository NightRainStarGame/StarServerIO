// 独立服务端进程：起真实 SSIO，定期把自身内存打到 stdout 供父进程采样。
// 与被测对象分离是关键 —— 同进程测量会把客户端持有的 100MB 也算进 RSS。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configForTest } from '../../packages/server/dist/env.js';
import { openDatabase } from '../../packages/server/dist/db/client.js';
import { runMigrations } from '../../packages/server/dist/db/migrate.js';
import { buildApp } from '../../packages/server/dist/app.js';

const dataDir = mkdtempSync(join(tmpdir(), 'ssio-bench-'));
const config = configForTest({ dataDir, LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '100000' });
const { db, sqlite } = openDatabase(join(dataDir, 'ssio.db'));
runMigrations(db);

const app = await buildApp({ db, config });
await app.listen({ host: '127.0.0.1', port: 0 });
const port = app.server.address().port;

console.log(`READY ${port} ${config.MASTER_KEY}`);

const timer = setInterval(() => {
  const m = process.memoryUsage();
  console.log(`MEM ${m.rss} ${m.heapUsed} ${m.external}`);
}, 150);

process.on('SIGTERM', async () => {
  clearInterval(timer);
  await app.close();
  sqlite.close();
  process.exit(0);
});
