import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * 环境变量校验（zod）。
 *
 * 硬规则：
 * - `JWT_SECRET` / `MASTER_KEY` 缺失或过短直接拒绝启动，绝不给默认值
 *   （默认值 = 全网上线同一把钥匙，是最典型的自托管安全事故）。
 */
const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().max(65535).default(8100),
  DATA_DIR: z.string().default('./data'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符（建议 openssl rand -hex 32）'),
  MASTER_KEY: z.string().min(16, 'MASTER_KEY 至少 16 字符'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.output<typeof EnvSchema>;

export interface ServerConfig extends Env {
  /** DATA_DIR 解析为绝对路径后的结果。 */
  dataDir: string;
  dbPath: string;
}

export function loadEnv(raw: Record<string, string | undefined> = process.env, baseDir: string = process.cwd()): ServerConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`环境变量校验失败：\n${issues}\n请对照 .env.example 补齐后重启。`);
  }
  const env = parsed.data;
  const dataDir = resolve(baseDir, env.DATA_DIR);
  return { ...env, dataDir, dbPath: resolve(dataDir, 'ssio.db') };
}

/**
 * 供测试使用：只给必填项设合法值，其余走默认。
 * `dataDir` 单独传（测试一律落在 os.tmpdir()），`DATA_DIR` 是相对路径，不能直接用绝对路径解析。
 */
export function configForTest(overrides: Record<string, string> & { dataDir: string }): ServerConfig {
  const raw: Record<string, string | undefined> = {
    JWT_SECRET: 'test-jwt-secret-'.padEnd(32, 'x'),
    MASTER_KEY: 'test-master-key-'.padEnd(16, 'x'),
    LOG_LEVEL: 'silent',
    ...overrides,
    DATA_DIR: overrides.dataDir,
  };
  return loadEnv(raw, '/');
}
