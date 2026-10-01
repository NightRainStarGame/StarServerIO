import type { AppRecord } from './api.js';

/**
 * 登录态：落在 localStorage。
 *
 * Master Key 与业务 APIKey 都是明文 —— 浏览器端没有更安全的存放方式，
 * 所以这里只做两件事：① 退出登录时清干净；② 界面上一律掩码显示，避免肩窥。
 */
export interface Session {
  baseUrl: string;
  masterKey: string;
  /** appId → 控制台为该应用签发的会话 Key。 */
  sessionKeys: Record<string, { id: string; key: string }>;
}

const KEY = 'ssio.console.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}

export function maskSecret(secret: string): string {
  return secret.length <= 8 ? '****' : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function appTitle(app: AppRecord): string {
  return `${app.name}（${app.slug}）`;
}
