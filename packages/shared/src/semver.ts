/**
 * 极简 semver 工具。
 *
 * 刻意不引第三方（semver 包体积不小，且我们只需要发布平台用到的比较与范围判定）。
 * 覆盖范围：`^1.2.0` / `~1.2` / `>=1.0.0 <2.0.0` / `1.2.3` / `*`，以及预发布版本比较。
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识符，如 `1.0.0-beta.1` → `['beta', '1']`；正式版为空数组。 */
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class SemVerError extends Error {
  constructor(input: string) {
    super(`非法的语义化版本号: ${input}`);
    this.name = 'SemVerError';
  }
}

export function isValid(input: string): boolean {
  return SEMVER_RE.test(input.trim());
}

export function parse(input: string): SemVer {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) throw new SemVerError(input);
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

export function format(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${base}-${v.prerelease.join('.')}` : base;
}

/** 比较两版本：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compare(a: string | SemVer, b: string | SemVer): number {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;

  if (x.major !== y.major) return x.major > y.major ? 1 : -1;
  if (x.minor !== y.minor) return x.minor > y.minor ? 1 : -1;
  if (x.patch !== y.patch) return x.patch > y.patch ? 1 : -1;

  return comparePrerelease(x.prerelease, y.prerelease);
}

/** 预发布比较：无预发布 > 有预发布；标识符逐段比，数字段优先级低于字母段。 */
function comparePrerelease(x: string[], y: string[]): number {
  if (x.length === 0 && y.length === 0) return 0;
  if (x.length === 0) return 1; // 1.0.0 > 1.0.0-beta
  if (y.length === 0) return -1;

  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const l = x[i];
    const r = y[i];
    if (l === undefined) return -1; // 短的在前面
    if (r === undefined) return 1;
    if (l === r) continue;

    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1;
    if (ln) return -1; // 数字标识符优先级低于字母标识符
    if (rn) return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  op: Operator;
  ver: SemVer;
}

function matchComparator(v: SemVer, c: Comparator): boolean {
  const d = compare(v, c.ver);
  switch (c.op) {
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '=':
      return d === 0;
  }
}

/**
 * 把一个 range token 展开为一组 comparator（AND 关系）。
 * `^` / `~` 会被展开成上界+下界两个约束。
 */
function expandComparator(token: string): Comparator[] {
  const t = token.trim();

  if (t === '*' || t === 'x' || t === 'X' || t === '') return [];

  if (t.startsWith('^')) {
    const raw = t.slice(1);
    const parts = raw.split('.');
    const v = parse(raw);
    // 上界随 major 是否为 0 变化：0.x 阶段 minor/patch 都可能是不兼容变更
    let upper: SemVer;
    if (v.major > 0) {
      upper = { major: v.major + 1, minor: 0, patch: 0, prerelease: [] };
    } else if (parts.length === 1) {
      // ^0 → >=0.0.0 <1.0.0
      upper = { major: 1, minor: 0, patch: 0, prerelease: [] };
    } else if (v.minor > 0 || parts.length === 2) {
      // ^0.2 / ^0.2.3 → <0.3.0；^0.0 → <0.1.0
      upper = { major: 0, minor: v.minor + 1, patch: 0, prerelease: [] };
    } else {
      // ^0.0.3 → <0.0.4
      upper = { major: 0, minor: 0, patch: v.patch + 1, prerelease: [] };
    }
    return [
      { op: '>=', ver: v },
      { op: '<', ver: upper },
    ];
  }

  if (t.startsWith('~')) {
    const raw = t.slice(1);
    const parts = raw.split('.');
    const v = parse(raw);
    // ~1.2 / ~1.2.3 → 锁定 minor；~1 → 只锁 major
    const upper: SemVer =
      parts.length >= 2
        ? { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [] }
        : { major: v.major + 1, minor: 0, patch: 0, prerelease: [] };
    return [
      { op: '>=', ver: v },
      { op: '<', ver: upper },
    ];
  }

  const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(t);
  if (!m) throw new SemVerError(t);
  const op = (m[1] as Operator | undefined) ?? '=';
  return [{ op, ver: parse(m[2]!) }];
}

function sameTriple(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * 判定版本是否满足 range。
 *
 * 预发布版本（如 `1.3.0-beta.1`）遵循 npm 语义：只有 range 中显式出现了
 * 同 `[major,minor,patch]` 的预发布版本时才算命中，避免 beta 被当成正式版推送给稳定渠道。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parse(version);
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    for (const c of expandComparator(token)) {
      if (!matchComparator(v, c)) return false;
    }
  }

  if (v.prerelease.length > 0) {
    const explicitlyAllowed = tokens.some((token) => {
      const raw = token.replace(/^[\^~]|^(<=|>=|<|>|=)/, '').trim();
      if (raw === '' || raw === '*') return false;
      if (!isValid(raw)) return false;
      const parsed = parse(raw);
      return parsed.prerelease.length > 0 && sameTriple(parsed, v);
    });
    if (!explicitlyAllowed) return false;
  }

  return true;
}
