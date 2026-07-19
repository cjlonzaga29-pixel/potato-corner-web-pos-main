import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, AccessTokenError, revokedTokenHash } from '../lib/verify-access-token.js';

export type AuthErrorCode = 'TOKEN_MISSING' | 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED';

function unauthorized(res: Response, code: AuthErrorCode): void {
  res.status(401).json({ data: null, error: { code }, meta: null });
}

/** Re-exported so existing call sites (auth.service.ts, tests) don't need to change their import path. */
export { revokedTokenHash };

/**
 * Request authentication flow (Architecture doc §3.3):
 * 1. Extract JWT from Authorization header
 * 2. Verify signature (RS256 public key)
 * 3. Check token expiry
 * 4. Check token ID against the Postgres revocation table (logged-out/revoked tokens)
 * 5. Extract identity/role and attach to req.user
 * 6. Hand off to route-specific authorization middleware
 * Any failure returns 401 with a specific error code so the client can
 * distinguish "just expired, try refresh" from "revoked, go to login".
 * Verification itself is shared with the Socket.io handshake middleware —
 * see lib/verify-access-token.ts.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    unauthorized(res, 'TOKEN_MISSING');
    return;
  }

  const token = header.slice('Bearer '.length);

  try {
    req.user = await verifyAccessToken(token);
  } catch (error) {
    if (error instanceof AccessTokenError) {
      unauthorized(res, error.code === 'TOKEN_EXPIRED' || error.code === 'TOKEN_REVOKED' ? error.code : 'TOKEN_INVALID');
      return;
    }
    throw error;
  }

  next();
}
