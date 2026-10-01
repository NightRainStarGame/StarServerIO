/**
 * APIKey 的 scope 常量与判定。
 *
 * 约定：只有 `admin:*` 是通配符，其余 scope 必须精确匹配。
 * 之所以不给每个资源都开 `xxx:*`，是为了让「最小权限」成为默认形态 —— 通配符越多越难审计。
 */
export const SCOPES = [
  'auth:read',
  'users:read',
  'release:read',
  'release:write',
  'storage:read',
  'storage:write',
  'forum:read',
  'forum:write',
  'cards:redeem',
  'source:read',
  'source:write',
  'announcements:read',
  'announcements:write',
  'admin:*',
] as const;

export type Scope = (typeof SCOPES)[number];

export function isKnownScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

/** 判定单个 scope 是否被授予。 */
export function hasScope(granted: readonly string[] | null | undefined, required: string): boolean {
  if (!granted || granted.length === 0) return false;
  if (granted.includes('admin:*')) return true;
  return granted.includes(required);
}

/** 判定一组 scope 是否全部被授予。 */
export function hasAllScopes(granted: readonly string[] | null | undefined, required: readonly string[]): boolean {
  return required.every((r) => hasScope(granted, r));
}

/** 签发 Key 前的合法性校验，返回非法项（空数组表示全部合法）。 */
export function validateScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !isKnownScope(s));
}
