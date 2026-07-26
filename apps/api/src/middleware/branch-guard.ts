import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { extractBranchId } from '../lib/request.js';
import { hasBranchAccess } from '../lib/branch-access.js';

/**
 * Branch authorization logic (Architecture doc §3.4). Must run after
 * `authenticate`. Extracts branch_id from request params, query, or body
 * (in that order):
 * - super_admin: skip the check entirely, access to all branches.
 * - supervisor: organization-wide access to every currently-active branch,
 *   resolved from the database via hasBranchAccess — never the JWT's
 *   branch_ids claim, which is only a snapshot from login/refresh time.
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
