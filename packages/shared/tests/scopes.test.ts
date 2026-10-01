import { describe, expect, it } from 'vitest';
import { hasAllScopes, hasScope, SCOPES, validateScopes } from '../src/scopes.js';

describe('hasScope', () => {
  it('精确匹配', () => {
    expect(hasScope(['release:read'], 'release:read')).toBe(true);
    expect(hasScope(['release:read'], 'release:write')).toBe(false);
  });

  it('admin:* 是唯一通配符', () => {
    expect(hasScope(['admin:*'], 'release:write')).toBe(true);
    expect(hasScope(['admin:*'], 'cards:redeem')).toBe(true);
    // 其余 scope 不带通配能力
    expect(hasScope(['release:*'], 'release:write')).toBe(false);
  });

  it('空集合 / null 一律拒绝', () => {
    expect(hasScope([], 'release:read')).toBe(false);
    expect(hasScope(null, 'release:read')).toBe(false);
    expect(hasScope(undefined, 'release:read')).toBe(false);
  });
});

describe('hasAllScopes', () => {
  it('要求全部命中', () => {
    expect(hasAllScopes(['release:read', 'storage:write'], ['release:read', 'storage:write'])).toBe(true);
    expect(hasAllScopes(['release:read'], ['release:read', 'storage:write'])).toBe(false);
    expect(hasAllScopes(['admin:*'], ['release:read', 'storage:write'])).toBe(true);
  });
});

describe('validateScopes', () => {
  it('识别未知 scope', () => {
    expect(validateScopes(['release:read', 'nope:write'])).toEqual(['nope:write']);
    expect(validateScopes(SCOPES as readonly string[])).toEqual([]);
  });
});
