import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { jwtPayloadSchema } from '@potato-corner/shared';
import { redis } from '../lib/redis.js';
import { sha256Hex } from '../lib/hash.js';
import { config } from '../config/index.js';

type AuthErrorCode = 'TOKEN_MISSING' | 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED';

function unauthorized(res: Response, code: AuthErrorCode): void {
  res.status(401).json({ data: null, error: { code }, meta: null });
}

/** Redis key for a blacklisted access token — see the Phase 1 design note in auth.service.ts. */
export function blacklistKey(token: string): string {
  return `auth:blacklist:${sha256Hex(token)}`;
}

/**
 * Request authentication flow (Architecture doc §3.3):
 * 1. Extract JWT from Authorization header
 * 2. Verify signature (RS256 public key)
 * 3. Check token expiry
 * 4. Check token ID against the Redis blacklist (logged-out/revoked tokens)
 * 5. Extract identity/role and attach to req.user
 * 6. Hand off to route-specific authorization middleware
 * Any failure returns 401 with a specific error code so the client can
 * distinguish "just expired, try refresh" from "revoked, go to login".
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    unauthorized(res, 'TOKEN_MISSING');
    return;
  }

  const token = header.slice('Bearer '.length);

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      unauthorized(res, 'TOKEN_EXPIRED');
    } else {
      unauthorized(res, 'TOKEN_INVALID');
    }
    return;
  }

  const isBlacklisted = await redis.get(blacklistKey(token));
  if (isBlacklisted) {
    unauthorized(res, 'TOKEN_REVOKED');
    return;
  }

  const parsed = jwtPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    unauthorized(res, 'TOKEN_INVALID');
    return;
  }

  req.user = parsed.data;
  next();
}
