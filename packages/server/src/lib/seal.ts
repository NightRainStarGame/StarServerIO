import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '@ssio/shared';

/**
 * 服务端内部的对称加密封装（AES-256-GCM）。
 *
 * 用途：卡密批次导出。服务端必须在「生成批次」与「导出 CSV」两个请求之间
 * 临时保存明文卡密，但明文落库是红线 —— 所以存密文，密钥派生自服务端主密钥。
 *
 * `purpose` 参与派生，保证不同用途的密文互不通用。
 */
function deriveKey(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`${secret}:${purpose}`).digest();
}

export function seal(secret: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, purpose), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function unseal(secret: string, purpose: string, blob: string): string {
  const parts = blob.split('.');
  if (parts.length !== 3) throw new AppError('INTERNAL', '密文格式损坏');
  const [ivB64, tagB64, encB64] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, purpose), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64url')), decipher.final()]);
  return dec.toString('utf8');
}
