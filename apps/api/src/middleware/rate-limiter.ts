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

/**
 * 10 requests per 15 minutes per IP + device_id combination — applied to
 * POST /api/auth/login and /api/auth/pin/login. Keyed the same way as
 * totpVerifyLimiter below rather than IP alone: both endpoints' schemas
 * (loginSchema, pinLoginSchema) require device_id, so a whole branch behind
 * one NAT'd IP no longer shares a single bucket — each device/terminal gets
 * its own budget, while a single attacker (one device_id, or none) is still
 * capped. Falls back to a per-IP 'unknown-device' bucket — same behavior as
 * today — if device_id is somehow missing (this runs before `validate()`,
 * so the field isn't guaranteed present yet).
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const deviceId = (req.body as Record<string, unknown> | undefined)?.device_id;
    const deviceKey = typeof deviceId === 'string' ? deviceId : 'unknown-device';
    return `${req.ip ?? 'unknown-ip'}:${deviceKey}`;
  },
  handler: rateLimitHandler,
});

/**
 * 10 requests per 15 minutes per authenticated branch account — applied to
 * POST /api/auth/select-employee. Unlike /login and /pin/login, this route
 * always runs after `authenticate`, so req.user is the JWT-verified branch
 * session rather than a client-supplied value by the time this key is
 * computed. Keying on that instead of IP+device_id is strictly safer here:
 * it can't be spoofed by omitting/rotating device_id, and it scopes the
 * limit to the one branch session making the request rather than every
 * terminal sharing the branch's egress IP.
 */
export const selectEmployeeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.user_id ?? req.ip ?? 'unknown',
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

/**
 * Task 209.48 — 20 requests per 10 minutes per IP, applied to
 * GET /api/receipts/:transactionNumber. Receipt numbers are sequential
 * per branch/day (see generateReceiptNumber in transactions.service.ts —
 * `{branchCode}-{date}-{counter}`, counter zero-padded to 6 digits), so
 * the generic 100/min apiLimiter is loose enough that an attacker could
 * still walk hundreds of neighboring receipt numbers per hour. This
 * limiter is IP-keyed (there's no authenticated user on a public,
 * unauthenticated endpoint) and deliberately more generous per-window
 * than it looks tight — 20 requests covers a customer reloading/sharing
 * a link several times, or several customers behind one branch/mall
 * NAT'd IP each looking up their own receipt — while still capping
 * sequential-number enumeration to a crawl.
 */
export const receiptLookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.ip ?? 'unknown',
  handler: rateLimitHandler,
});

/**
 * Shared key for both staff-PIN-verify limiters below — the authenticated
 * actor submitting the operation within a branch, not the staff identity
 * whose PIN was guessed, so a string of wrong guesses throttles the
 * *guesser*'s budget rather than ever being usable to enumerate which staff
 * identity is currently locked out — there is no staff-keyed lockout state
 * anywhere, only these two short, per-actor windows.
 */
function staffPinVerifyKey(req: Request): string {
  const branchId = (req.params as Record<string, unknown> | undefined)?.branchId;
  const branchKey = typeof branchId === 'string' ? branchId : 'unknown-branch';
  return `${branchKey}:${req.user?.user_id ?? req.ip ?? 'unknown'}`;
}

/**
 * POS-PERF-P29R2 — 5 *failed* PIN attempts per 5 minutes per (branchId,
 * actor). `skipSuccessfulRequests: true` means a correct PIN (the verify
 * route responds 200) never consumes this budget — only a wrong-PIN 401
 * does (StaffPinError's statusCode, surfaced via handleModuleError, is what
 * express-rate-limit's default `requestWasSuccessful` checks:
 * res.statusCode < 400). This is the actual brute-force/enumeration
 * lockout: five wrong guesses in five minutes blocks further guessing
 * regardless of how many correct verifications happened in between, and
 * concurrent guesses against the same key are serialized by the same
 * counter (express-rate-limit's MemoryStore increments synchronously per
 * event-loop tick, so a burst of parallel wrong-PIN requests still can't
 * exceed the limit before the 6th is rejected).
 */
export const staffPinVerifyFailureLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: staffPinVerifyKey,
  handler: rateLimitHandler,
});

/**
 * POS-PERF-P29R2 — 30 requests per 5 minutes per (branchId, actor),
 * counting successes AND failures. This is the resource-protection cap
 * (BCRYPT_COST_FACTOR=12 in staff-pin.service.ts makes each attempt
 * deliberately expensive) rather than a brute-force lockout: a branch
 * terminal doing six back-to-back legitimate receiving/adjustment entries,
 * each gated by its own correct PIN verification, stays well under it,
 * while a flood of requests (even all correctly-PIN'd, or a mix) that would
 * otherwise hammer bcrypt.compare at cost factor 12 request after request
 * still gets capped.
 */
export const staffPinVerifyOverallLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: staffPinVerifyKey,
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
