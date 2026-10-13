import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { extractBranchId } from '../lib/request.js';
import { hasBranchAccess } from '../lib/branch-access.js';

/**
 * Branch authorization logic (Architecture doc §3.4). Must run after
 * `authenticate`. Extracts branch_id from request params, query, or body
 * (in that order):
 * - super_admin: skip the check entirely, access to all branches.
 * - supervisor: scoped to their active UserBranchAssignment rows, resolved
 *   from the database via hasBranchAccess — never the JWT's branch_ids
 *   claim, which is only a snapshot from login/refresh time.
 * - branch / staff: requested branch_id must equal the user's single assigned branch.
 * (An active-shift check for POS endpoints is a separate, route-specific
 * middleware — not duplicated here.)
 */
export async function branchGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return;
  }

  if (req.user.role === ROLES.SUPER_ADMIN) {
    next();
    return;
  }

  const branchId = extractBranchId(req);
  if (!branchId) {
    res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
    return;
  }

  if (!(await hasBranchAccess(req.user, branchId))) {
    res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
    return;
  }

  next();
}

/**
 * POS-PERF-P36R2 — variant for the one route (PATCH /products/:productId/
 * status) whose own doc comment says branch_id is intentionally optional:
 * omitted, it's a global lifecycle change (archive/discontinue/restore),
 * authorized entirely inside products.service.ts's changeProductStatus
 * (hasActiveCatalogAuthorityForProduct); present, it's a branch-scoped
 * availability flip that still needs the same hasBranchAccess check
 * `branchGuard` enforces everywhere else. Plain `branchGuard` doesn't know
 * this distinction — it 400s BRANCH_ID_REQUIRED unconditionally for every
 * non-super_admin caller, which made every supervisor's Archive/Discontinue/
 * Restore action fail outright (confirmed with a real browser: the Archive
 * confirmation dialog never closed, because the PATCH itself 400'd before
 * the service's own authority check ever ran). Skips straight to `next()`
 * when branch_id is absent; defers to the real `branchGuard` otherwise.
 */
export async function branchGuardOptional(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return;
  }
  if (!extractBranchId(req)) {
    next();
    return;
  }
  await branchGuard(req, res, next);
}
