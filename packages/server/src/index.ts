import { config as loadDotenv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv } from './env.js';
import { buildApp } from './app.js';
import { VERSION } from './version.js';

// 已存在的环境变量优先级更高（容器/K8s 注入的场景不应被 .env 覆盖）
loadDotenv({ override: false });

async function main(): Promise<void> {
  const config = loadEnv();
  mkdirSync(config.dataDir, { recursive: true });

  const { db, sqlite } = openDatabase(config.dbPath);
  runMigrations(db);

  // 生产入口启动 janitor：过期上传会话与 refresh token 不靠人清
  const app = await buildApp({ db, config, janitorIntervalMs: 60 * 60 * 1000 });
  await app.listen({ host: config.HOST, port: config.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // 启动失败必须显式退出码，否则 systemd 会认为服务还活着
  console.error('[ssio] 启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});

export { VERSION };
