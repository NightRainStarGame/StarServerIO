import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * CLI 配置：落在 ~/.ssio/config.json。
 *
 * 里面会存 Master Key 与 APIKey 明文 —— 这是运维工具的固有取舍（不然每次都要手输）。
 * 因此文件权限显式收紧到 0600，并在 `config show` 里默认掩码。
 */
export interface AppEntry {
  appId: string;
  apiKey: string;
}

export interface CliConfig {
  url: string;
  masterKey?: string;
  /** slug → { appId, apiKey }。签发 Key 时默认写入，业务命令按 slug 取。 */
  apps: Record<string, AppEntry>;
}

/**
 * 配置文件路径：环境变量 SSIO_CONFIG 可覆盖（测试用，避免污染真实 home）。
 * 每次调用都重新解析，而不是在模块加载时算死 —— 否则测试里的 stubEnv 不生效。
 */
export function configPath(): string {
  return process.env.SSIO_CONFIG ?? join(homedir(), '.ssio', 'config.json');
}

export function loadConfig(): CliConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<CliConfig>;
    return { url: raw.url ?? 'http://127.0.0.1:8100', masterKey: raw.masterKey, apps: raw.apps ?? {} };
  } catch {
    return { url: 'http://127.0.0.1:8100', apps: {} };
  }
}

export function saveConfig(config: CliConfig): void {
  const target = configPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** 环境变量优先：CI 里不方便写文件时用 SSIO_URL / SSIO_MASTER_KEY。 */
export function resolveUrl(config: CliConfig): string {
  return process.env.SSIO_URL ?? config.url;
}

export function resolveMasterKey(config: CliConfig): string | undefined {
  return process.env.SSIO_MASTER_KEY ?? config.masterKey;
}

export function mask(secret: string | undefined): string {
  if (!secret) return '(未设置)';
  return secret.length <= 8 ? '****' : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
