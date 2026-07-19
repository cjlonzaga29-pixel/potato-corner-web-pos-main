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

  const revoked = await prisma.revokedToken.findFirst({
    where: { tokenHash: revokedTokenHash(token), expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (revoked) {
    throw new AccessTokenError('TOKEN_REVOKED', 'token revoked');
  }

  const parsed = jwtPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AccessTokenError('TOKEN_INVALID_PAYLOAD', 'invalid token payload');
  }

  return parsed.data;
}
