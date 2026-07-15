import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { redis } from '../lib/redis.js';

function redisStore(prefix: string): RedisStore {
  return new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as Promise<never>,
    prefix,
  });
}

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
  store: redisStore('rl:login:'),
  handler: rateLimitHandler,
});

/** 3 requests per hour per email — applied to POST /api/auth/request-reset. */
export const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:reset:'),
  keyGenerator: (req: Request) => {
    const email = (req.body as Record<string, unknown> | undefined)?.email;
    return typeof email === 'string' ? email.toLowerCase() : req.ip ?? 'unknown';
  },
  handler: rateLimitHandler,
});

/** 100 requests per minute — applied globally; keyed by authenticated user when available, else IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:api:'),
  keyGenerator: (req: Request) => req.user?.user_id ?? req.ip ?? 'unknown',
  handler: rateLimitHandler,
});
