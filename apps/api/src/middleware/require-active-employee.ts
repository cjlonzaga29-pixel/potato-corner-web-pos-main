import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { employeesRepository } from '../modules/employees/employees.repository.js';

const ACTIVE_STATUS_CACHE_TTL_MS = 10_000;
/** userId -> cache-entry expiry. Only a confirmed-ACTIVE result is ever cached (mirrors verify-access-token.ts's isTokenRevoked positive-cache pattern) — a status change is visible on the very next request after the cache entry naturally expires, never masked. */
const activeStatusCache = new Map<string, number>();

/**
 * SESSION CONTROL (CR-003): re-validates a `staff` (Employee) session's live
 * status on every request to a branch-operational route (POS, attendance,
 * cash shifts). setEmployeeStatus revokes refresh tokens and force-drops
 * any live socket connection the instant status leaves ACTIVE, but the
 * already-issued access token itself stays cryptographically valid until
 * its own short TTL expires — this closes that window server-side instead
 * of relying on TTL alone. Must run after `authenticate`. A no-op query for
 * every other role: employee status transitions never apply to
 * branch/supervisor/super_admin accounts.
 */
export async function requireActiveEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user || req.user.role !== ROLES.STAFF) {
    next();
    return;
  }

  const userId = req.user.user_id;
  const now = Date.now();
  const cachedExpiry = activeStatusCache.get(userId);
  if (cachedExpiry && cachedExpiry > now) {
    next();
    return;
  }

  const employee = await employeesRepository.findStatusById(userId);
  if (!employee || employee.status !== 'active' || !employee.isActive) {
    res.status(403).json({
      data: null,
      error: { code: 'EMPLOYEE_INACTIVE', message: 'This employee session is no longer active' },
      meta: null,
    });
    return;
  }

  activeStatusCache.set(userId, now + ACTIVE_STATUS_CACHE_TTL_MS);
  if (activeStatusCache.size > 10_000) {
    for (const [key, expiry] of activeStatusCache) {
      if (expiry < now) activeStatusCache.delete(key);
    }
  }
  next();
}
