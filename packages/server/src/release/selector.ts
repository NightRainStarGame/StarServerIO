import { createHash } from 'node:crypto';
import { compare } from '@ssio/shared';

/**
 * 发行版本选择器。
 *
 * 刻意做成**纯函数**：不查库、不读时钟，输入一批候选行就给出结论。
 * 这样 8 种灰度/强制/平台匹配的场景可以用单测全覆盖，不必起服务。
 */

export interface ReleaseRow {
  id: string;
  version: string;
  channel: string;
  platform: string;
  arch: string;
  fileId: string;
  sizeBytes: number;
  sha256: string;
  notesMd: string | null;
  mandatory: boolean;
  minVersion: string | null;
  rolloutPercent: number;
  published: boolean;
  downloadCount: number;
  createdAt: number;
  deletedAt: number | null;
}

export interface LatestQuery {
  platform: string;
  channel: string;
  arch?: string;
  /** 客户端当前版本。缺省视为「从未安装过」。 */
  current?: string;
  /** 灰度分桶用的稳定标识（设备 ID / 安装 ID）。缺省视为全量命中。 */
  clientId?: string;
}

export type LatestResult = { hasUpdate: false } | { hasUpdate: true; release: ReleaseRow; mandatory: boolean };

/**
 * 灰度分桶：把 `clientId + version` 散列为 0-99。
 *
 * 之所以把 version 一起混入：否则同一个 client 在任何版本上都落在同一个桶，
 * 灰度从 10% 调到 20% 时，同一批人会被反复命中，灰度比例失真。
 */
export function rolloutBucket(clientId: string, version: string): number {
  const digest = createHash('sha256').update(`${clientId}:${version}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/** 判定某版本是否对该客户端放量。clientId 缺省时按全量（100）处理。 */
export function inRollout(row: Pick<ReleaseRow, 'version' | 'rolloutPercent'>, clientId?: string): boolean {
  const percent = row.rolloutPercent;
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  if (!clientId) return true;
  return rolloutBucket(clientId, row.version) < percent;
}

export function pickLatest(rows: readonly ReleaseRow[], q: LatestQuery): LatestResult {
  const arch = q.arch ?? 'any';

  const candidates = rows.filter((r) => {
    if (!r.published || r.deletedAt !== null) return false;
    if (r.channel !== q.channel) return false;
    // platform / arch 为 `any` 的记录对所有目标生效
    if (r.platform !== q.platform && r.platform !== 'any') return false;
    return r.arch === arch || r.arch === 'any';
  });

  if (candidates.length === 0) return { hasUpdate: false };

  // 版本降序：semver 比较，1.10.0 必须排在 1.9.0 之后（字符串比较会排错）
  const sorted = [...candidates].sort((a, b) => compare(b.version, a.version));
  const target = sorted[0]!;

  // 已经是最新或更高 → 没有更新
  if (q.current && compare(q.current, target.version) >= 0) return { hasUpdate: false };

  // minVersion：低于下限的客户端强制升级，且不受灰度限制
  const forced = q.current !== undefined && target.minVersion !== null && compare(q.current, target.minVersion) < 0;
  if (!forced && !inRollout(target, q.clientId)) return { hasUpdate: false };

  return { hasUpdate: true, release: target, mandatory: forced || target.mandatory };
}
