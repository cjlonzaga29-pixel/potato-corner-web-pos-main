import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.js';

export const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const SESSION_COOKIE_NAME = 'refresh_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints intentionally exempt from the double-submit check even once a
 * session cookie exists: /api/auth/refresh is invoked directly by
 * apps/web/middleware.ts on the Next.js server (not the browser), which has
 * no way to attach the X-CSRF-Token header. Its own opaque-token rotation
 * (locked rule — every use revokes and reissues) is the CSRF mitigation for
 * this one route instead.
 */
const EXEMPT_PATHS = new Set(['/api/auth/refresh']);

function issueCsrfCookie(req: Request, res: Response): string {
  const existing = req.cookies?.[CSRF_COOKIE_NAME];
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  });
  return token;
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Double-submit cookie CSRF guard. A non-HttpOnly cookie carries the token
 * so frontend JS can echo it back as a header — an attacker's cross-site
 * request rides the cookie automatically but can't read it to forge the
 * matching header.
 *
 * Enforcement only applies once a session (refresh_token cookie) exists:
 * pre-login requests (e.g. POST /api/auth/login) have no session to hijack,
 * and every route actually gated by apps/api/src/middleware/authenticate.ts
 * already requires a bearer token a cross-site form/script cannot supply.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const token = issueCsrfCookie(req, res);

  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  if (EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  const hasSession = typeof req.cookies?.[SESSION_COOKIE_NAME] === 'string';
  if (!hasSession) {
    next();
    return;
  }

  const headerToken = req.headers[CSRF_HEADER_NAME];
  if (typeof headerToken !== 'string' || !timingSafeEqual(token, headerToken)) {
    res.status(403).json({ data: null, error: { code: 'CSRF_TOKEN_INVALID' }, meta: null });
    return;
  }

  next();
}
