import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** APIKey 明文形如 `ssio_live_<22位base62>`；前缀固定，便于日志与网关侧识别。 */
export const API_KEY_PREFIX = 'ssio_live_';
export const API_KEY_RANDOM_LENGTH = 22;

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 无偏 base62 随机串。
 * 用拒绝采样而非 `byte % 62`：后者会让前 4 个字符出现概率偏高，属于可被利用的偏差。
 */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (const byte of buf) {
      // 62 * 4 = 248，丢弃 >= 248 的字节以保持均匀分布
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface GeneratedApiKey {
  key: string;
  keyPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBase62(API_KEY_RANDOM_LENGTH)}`;
  return { key, keyPrefix: keyPrefixOf(key) };
}

/** 取前 16 个字符（含 `ssio_live_`），足够定位又不泄露可用熵。 */
export function keyPrefixOf(key: string): string {
  return key.slice(0, 16);
}

/**
 * 列表接口的掩码形态。
 *
 * 刻意**不**保留尾 4 位（需求里写的 `ssio_live_abcd…wxyz`）：掩码的作用是给人核对，
 * 不需要可被反推；少泄露 4 个字符能降低撞库与社工的收益。
 */
export function maskApiKey(keyPrefix: string): string {
  return `${keyPrefix}${'*'.repeat(8)}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * APIKey 落库哈希。
 *
 * 用裸 sha256（不像密码那样需要 KDF）：Key 本身是 132 位随机熵，不存在弱口令/彩虹表问题，
 * 而查询需要 O(1) 命中，加盐 KDF 反而会让每次请求都付出一次慢哈希的代价。
 */
export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

/** 恒定时间字符串比较，避免通过响应耗时逐字节猜密钥。 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // 长度不同时也走一次比较再返回，避免「快速失败」泄露长度信息
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
