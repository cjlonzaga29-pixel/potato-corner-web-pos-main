import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Phase 21: Redis-backed store removed — falls back to express-rate-limit's
 * default in-memory MemoryStore. That store is per-process, so limits are
 * no longer shared across API instances (each instance enforces its own
 * window independently); acceptable for now per the Phase 21 directive,
 * revisit with a Postgres-backed store if/when the API runs as more than
 * one instance.
 */

/**
 * express-rate-limit's default limit-exceeded response is a plain-text
 * body ("Too many requests, please try again later."), which breaks every
 * caller that assumes the API's standard { data, error, meta } JSON
 * envelope (e.g. apps/web's apiClient calls response.json() unconditionally
 * and throws a SyntaxError on that plain text). Every limiter below sets
 * this handler so a 429 is just another JSON error response.
 */
const rateLimitHandler: Options['handler'] = (_req: Request, res: Response) => {
  res.status(429).json({
    data: null,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' },
    meta: null,
  });
};

/** 10 requests per 15 minutes per IP — applied to POST /api/auth/login. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/** 3 requests per hour per email — applied to POST /api/auth/request-reset. */
export const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = (req.body as Record<string, unknown> | undefined)?.email;
    return typeof email === 'string' ? email.toLowerCase() : req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
});

/**
 * 5 attempts per 15 minutes per IP + device_id combination — applied to
 * POST /api/auth/2fa/verify-login and /2fa/verify-backup-code. Keyed by
 * device_id (not the not-yet-authenticated user) since that's the only
 * stable identifier available pre-session on these endpoints.
 */
export const totpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const deviceId = (req.body as Record<string, unknown> | undefined)?.device_id;
    const deviceKey = typeof deviceId === 'string' ? deviceId : 'unknown-device';
    return `${req.ip ?? 'unknown-ip'}:${deviceKey}`;
  },
  handler: rateLimitHandler,
});

/** 100 requests per minute — applied globally; keyed by authenticated user when available, else IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.user_id ?? req.ip ?? 'unknown',
  handler: rateLimitHandler,
});
