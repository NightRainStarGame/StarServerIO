import { SignJWT, errors, jwtVerify } from 'jose';

/**
 * JWT（HS256）。access 15 分钟，refresh 30 天。
 *
 * refresh token 只以 sha256 落库，服务端不存明文 —— 数据库泄露不等于会话泄露。
 */

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  sub: string;
  appId: string;
  type: 'access';
}

export interface RefreshClaims {
  sub: string;
  appId: string;
  type: 'refresh';
  jti: string;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(secret: string, userId: string, appId: string): Promise<string> {
  return new SignJWT({ appId, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + ACCESS_TTL_MS) / 1000))
    .sign(secretKey(secret));
}

export async function signRefreshToken(
  secret: string,
  userId: string,
  appId: string,
  jti: string,
): Promise<string> {
  return new SignJWT({ appId, type: 'refresh', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + REFRESH_TTL_MS) / 1000))
    .sign(secretKey(secret));
}

export type VerifyResult<T> = { ok: true; claims: T & { exp?: number } } | { ok: false; expired: boolean };

export async function verifyToken<T extends { type: string }>(
  secret: string,
  token: string,
  expectedType: T['type'],
): Promise<VerifyResult<T>> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== expectedType) return { ok: false, expired: false };
    return { ok: true, claims: payload as unknown as T & { exp?: number } };
  } catch (e) {
    // 过期单独区分：SDK 需要靠它触发 refresh 而不是直接登出
    if (e instanceof errors.JWTExpired) return { ok: false, expired: true };
    return { ok: false, expired: false };
  }
}
