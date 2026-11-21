import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

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
 * POS-PERF-P29R2/R4/R5 — 5 *failed* PIN attempts per 5 minutes per
 * (branchId, actor). This is the actual brute-force/enumeration lockout:
 * five wrong guesses in five minutes blocks further guessing regardless of
 * how many correct verifications happened in between, and concurrent
 * guesses against the same key are serialized by the same counter
 * (express-rate-limit's MemoryStore increments synchronously per
 * event-loop tick, so a burst of parallel wrong-PIN requests still can't
 * exceed the limit before the 6th is rejected).
 *
 * `requestWasSuccessful` overrides express-rate-limit's default
 * status-code check (res.statusCode < 400). A plain status check cannot
 * tell "the PIN itself was wrong" apart from any other non-2xx outcome
 * reaching this same route — a malformed draft rejected by validate() with
 * 422, a DB/storage failure thrown before bcrypt ever ran, or (pre-R4) the
 * resource-cap limiter's own 429 — every one of those would otherwise be
 * misread as a "failure" and silently burn one unit of the wrong-PIN
 * budget for an attempt that never actually checked a PIN. The verify-pin
 * route handler (staff-pin.router.ts) sets
 * `res.locals.staffPinInvalid = true` ONLY when staffPinService.verifyPin
 * throws its genuine StaffPinError('INVALID_PIN', ...); every other
 * outcome — success, validation error, infra error — leaves it unset, so
 * `requestWasSuccessful` reports true (skip) for all of them and this
 * counter only ever reflects real wrong-PIN attempts.
 *
 * MUST be mounted AFTER staffPinVerifyOverallLimiter on any route (see
 * staff-pin.router.ts's /branches/:branchId/verify) — belt-and-suspenders
 * with the fix above: mounting the resource cap first means a request it
 * rejects never reaches this limiter (or the route handler) at all.
 */
export const staffPinVerifyFailureLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req: Request, res: Response) => !(res as Response & { locals: Record<string, unknown> }).locals.staffPinInvalid,
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

/**
 * POS-PERF-P62 — the global budget, applied before authentication. It used to
 * key on req.user, which nothing had set yet at this point, so every request
 * was counted per IP and all the terminals and dashboards behind one branch
 * connection shared 100 requests a minute.
 *
 * A request is counted against its user only when its bearer token verifies
 * (RS256 signature and expiry; revocation is still checked by authenticate).
 * Anything else, including a forged or expired token and every header a client
 * can set, falls back to the unchanged per-IP budget. req.ip comes from
 * trust proxy (app.ts), never from a header read here. The dedicated login,
 * PIN, 2FA and reset limiters above apply on top of this.
 *
 * Counters are kept in this process's memory, so each API instance counts on
 * its own. See the P62 runbook, §5.
 */
export const API_LIMIT_PER_IP_PER_MINUTE = 100;
export const API_LIMIT_PER_USER_PER_MINUTE = 300;

const unauthenticatedApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_LIMIT_PER_IP_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `ip:${req.ip ?? 'unknown'}`,
  handler: rateLimitHandler,
});

const authenticatedApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_LIMIT_PER_USER_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req: Request, res: Response) => `user:${String(res.locals.rateLimitUserId)}`,
  handler: rateLimitHandler,
});

/** The user id of a bearer token that verifies, or null. Never trusts an unverified claim. */
export function verifiedRateLimitUserId(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice('Bearer '.length), config.jwt.publicKey, { algorithms: ['RS256'] });
    if (typeof payload === 'object' && typeof payload.user_id === 'string' && payload.user_id.length > 0) return payload.user_id;
  } catch {
    // Forged, expired or malformed: counted per IP.
  }
  return null;
}

/**
 * POS-PERF-P62 — signing out must not depend on the shared budget. Found in the
 * P62 browser run: a logout refused with 429 left the server session and its
 * cookies in place, the web cleared itself, and its middleware sent /login
 * straight back to the dashboard, so "Log out" appeared to do nothing. Every
 * terminal of a branch shares one account's budget, so a busy branch can be at
 * the limit. A verified user's logout has its own, separate per-user budget.
 */
export const LOGOUT_LIMIT_PER_USER_PER_MINUTE = 30;
const LOGOUT_PATHS = new Set(['/api/auth/logout', '/api/auth/logout-all']);

const logoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: LOGOUT_LIMIT_PER_USER_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req: Request, res: Response) => `logout:${String(res.locals.rateLimitUserId)}`,
  handler: rateLimitHandler,
});

export const apiLimiter: RequestHandler = (req, res, next) => {
  const userId = verifiedRateLimitUserId(req);
  if (userId === null) return unauthenticatedApiLimiter(req, res, next);
  res.locals.rateLimitUserId = userId;
  if (req.method === 'POST' && LOGOUT_PATHS.has(req.path)) return logoutLimiter(req, res, next);
  return authenticatedApiLimiter(req, res, next);
};
