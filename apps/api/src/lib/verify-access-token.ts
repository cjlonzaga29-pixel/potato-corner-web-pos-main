import jwt from 'jsonwebtoken';
import { jwtPayloadSchema, type JwtPayload } from '@potato-corner/shared';
import { prisma } from './prisma.js';
import { sha256Hex } from './hash.js';
import { config } from '../config/index.js';

export type AccessTokenErrorCode =
  | 'TOKEN_MALFORMED'
  | 'TOKEN_INVALID_SIGNATURE'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'TOKEN_INVALID_PAYLOAD';

export class AccessTokenError extends Error {
  constructor(
    public readonly code: AccessTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccessTokenError';
  }
}

/**
 * Phase 21: token hash used as the RevokedToken table's key — see the
 * Phase 1 design note in auth.service.ts (blacklistToken). Renamed from
 * blacklistKey now that it's a plain hash, not a Redis key.
 */
export function revokedTokenHash(token: string): string {
  return sha256Hex(token);
}

/**
 * POS-PERF-P64 — a removed account's marker row in the same RevokedToken
 * table. Removal writes it in the removal transaction (so the out-of-process
 * fixture cleanup script cuts sessions too), and every access token is checked
 * against its owner's marker as well as its own hash. The marker only has to
 * outlive the longest access token issued before the removal; login and
 * refresh refuse the account from then on.
 */
export function removedAccountRevocationHash(userId: string): string {
  return sha256Hex(`removed-account:${userId}`);
}
export const REMOVED_ACCOUNT_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

const NOT_REVOKED_CACHE_TTL_MS = 60_000;
const notRevokedCache = new Map<string, number>(); // tokenHash → cache-entry expiry

/**
 * Single Render instance (no Redis adapter since Phase 21), so an
 * in-process cache is consistent across requests. Only the negative
 * result is cached — a revoked token always hits the DB, so this never
 * masks a *future* revocation, only delays visibility of one by up to
 * NOT_REVOKED_CACHE_TTL_MS on tokens already cached as clean.
 */
/**
 * POS-PERF-P62 — called by whatever writes a revocation in this process (logout,
 * logout-all, password change), so a token checked moments earlier isn't still
 * accepted from the cache above for up to NOT_REVOKED_CACHE_TTL_MS afterwards.
 */
export function forgetNotRevoked(tokenHash: string): void {
  notRevokedCache.delete(tokenHash);
}

/**
 * POS-PERF-P64 — an account was removed in this process. The cache is keyed
 * by token, not user, so it is cleared entirely; removals are rare and the
 * next request per token simply re-reads the table.
 */
export function forgetAccountStatus(userId: string): void {
  void userId;
  notRevokedCache.clear();
}

async function isTokenRevoked(tokenHash: string, userId: string | null): Promise<boolean> {
  const now = Date.now();
  const cachedExpiry = notRevokedCache.get(tokenHash);
  if (cachedExpiry && cachedExpiry > now) {
    return false;
  }

  const revoked = await prisma.revokedToken.findFirst({
    where: { tokenHash, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (revoked) {
    return true;
  }
  if (userId) {
    const removed = await prisma.revokedToken.findFirst({
      where: { tokenHash: removedAccountRevocationHash(userId), expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (removed) return true;
  }

  notRevokedCache.set(tokenHash, now + NOT_REVOKED_CACHE_TTL_MS);
  if (notRevokedCache.size > 10_000) {
    for (const [key, expiry] of notRevokedCache) {
      if (expiry < now) notRevokedCache.delete(key);
    }
  }
  return false;
}

/**
 * Single source of truth for access-token verification, shared by the HTTP
 * `authenticate` middleware and the Socket.io handshake middleware so both
 * transports enforce identical rules:
 * 1. Verify signature (RS256 public key)
 * 2. Check token expiry
 * 3. Check the token against the Postgres revocation table (logged-out/revoked tokens)
 * 4. Validate the decoded payload shape
 * Throws `AccessTokenError` with a specific code on any failure; callers
 * map that code to their transport's own error format (HTTP status/body,
 * Socket.io `next(new Error(...))`).
 */
export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AccessTokenError('TOKEN_EXPIRED', 'jwt expired');
    }
    if (error instanceof jwt.JsonWebTokenError && error.message === 'invalid signature') {
      throw new AccessTokenError('TOKEN_INVALID_SIGNATURE', 'invalid signature');
    }
    throw new AccessTokenError('TOKEN_MALFORMED', error instanceof Error ? error.message : 'jwt malformed');
  }

  const claimedUserId =
    decoded && typeof decoded === 'object' && typeof (decoded as { user_id?: unknown }).user_id === 'string'
      ? (decoded as { user_id: string }).user_id
      : null;
  if (await isTokenRevoked(revokedTokenHash(token), claimedUserId)) {
    throw new AccessTokenError('TOKEN_REVOKED', 'token revoked');
  }

  const parsed = jwtPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AccessTokenError('TOKEN_INVALID_PAYLOAD', 'invalid token payload');
  }

  return parsed.data;
}
