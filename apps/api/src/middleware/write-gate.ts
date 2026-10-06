import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { AccessTokenError, verifyAccessToken } from '../lib/verify-access-token.js';
import { settingsRepository } from '../modules/settings/settings.repository.js';
import { WRITE_GATE_KEY, resolveWriteGateState } from '../modules/settings/settings.types.js';
import { recordAuditLog } from './audit-log.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BYPASS_HEADER = 'x-maintenance-bypass';

/**
 * Checkout and every known inventory-stock-mutating HTTP surface this gate
 * protects. A regex list, not a plain prefix list, because two of them
 * (`inventory`, `inventory-stock`) are nested under the dynamic
 * `/api/branches/:branchId/...` path rather than owning their own top-level
 * prefix — see docs/runbooks/pos-perf-p16-write-gate.md for the full
 * enumeration this was built from.
 */
const GATED_PATH_PATTERNS: RegExp[] = [
  /^\/api\/transactions(\/|$)/,
  /^\/api\/inventory(\/|$)/,
  /^\/api\/product-inventory(\/|$)/,
  /^\/api\/universal-inventory(\/|$)/,
  /^\/api\/product-components(\/|$)/,
  /^\/api\/branches\/[^/]+\/inventory(\/|$)/,
  /^\/api\/branches\/[^/]+\/inventory-stock(\/|$)/,
];

function isGatedRequest(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  return GATED_PATH_PATTERNS.some((pattern) => pattern.test(req.path));
}

/**
 * Per-process count of requests currently inside a gated route, regardless
 * of whether the gate let them through or is about to reject them with a
 * 503 (both paths run this file's increment/decrement). This is the
 * verified-drain signal POS-PERF-P16 requires: closing the gate (flipping
 * `enabled: true`) stops *new* gated requests from reaching their handler,
 * but does nothing for ones already past this point — operators must poll
 * this count down to 0 (GET /api/settings/write-gate) before assuming it is
 * safe to swap/stop the instance. Deliberately per-instance, not
 * cluster-wide: during a Render swap, the OLD instance's own count is what
 * must drain before it is torn down — a shared counter would conflate the
 * two instances and could never prove the old one is actually idle.
 */
let activeGatedRequests = 0;

export function getActiveGatedRequestCount(): number {
  return activeGatedRequests;
}

async function resolveBypassActor(req: Request): Promise<{ id: string; role: string } | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  try {
    const payload = await verifyAccessToken(header.slice('Bearer '.length));
    return { id: payload.user_id, role: payload.role };
  } catch (error) {
    if (error instanceof AccessTokenError) return null;
    throw error;
  }
}

/**
 * Server-enforced, DB-backed maintenance gate (POS-PERF-P16). Reads the
 * gate's state fresh from Postgres on every gated request — no in-process
 * caching — so every instance (old and new, during a Render deploy-swap
 * overlap window) observes the exact same open/closed decision at the same
 * moment, which an in-memory flag could never guarantee across processes.
 *
 * "Narrowly authorized maintenance/recovery access" (required by this
 * release) is a per-request opt-in, not a blanket role exemption: a
 * SUPER_ADMIN-issued access token AND the `X-Maintenance-Bypass` header
 * (any non-empty justification string) must both be present. An ordinary
 * cashier/admin client never sends that header, so normal checkout/
 * inventory traffic is blocked outright while gated; a human deliberately
 * running a documented recovery action (e.g. retrying a stuck job, voiding
 * a sale) can still reach it. Every bypass is audit-logged.
 */
export async function writeGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isGatedRequest(req)) {
    next();
    return;
  }

  activeGatedRequests += 1;
  let settled = false;
  const release = (): void => {
    if (settled) return;
    settled = true;
    activeGatedRequests -= 1;
  };
  res.once('finish', release);
  res.once('close', release);

  try {
    const setting = await settingsRepository.findSystemSetting(WRITE_GATE_KEY);
    const state = resolveWriteGateState(setting?.value);

    if (!state.enabled) {
      next();
      return;
    }

    const bypassReason = req.headers[BYPASS_HEADER];
    if (typeof bypassReason === 'string' && bypassReason.length > 0) {
      const actor = await resolveBypassActor(req);
      if (actor?.role === ROLES.SUPER_ADMIN) {
        await recordAuditLog({
          action: 'MAINTENANCE_GATE_BYPASS',
          entityType: 'system_setting',
          entityId: WRITE_GATE_KEY,
          actorId: actor.id,
          actorRole: actor.role,
          afterState: { path: req.path, method: req.method, reason: bypassReason },
          ipAddress: req.ip ?? null,
        });
        next();
        return;
      }
    }

    res.set('Retry-After', '30');
    res.status(503).json({
      data: null,
      error: {
        code: 'SERVICE_WRITE_GATE_CLOSED',
        message: 'Temporarily unavailable for maintenance. Please try again shortly.',
        details: { reason: state.reason },
      },
      meta: null,
    });
  } catch (error) {
    next(error);
  }
}
