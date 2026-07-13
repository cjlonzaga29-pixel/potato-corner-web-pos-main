import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { extractBranchId } from '../lib/request.js';

/**
 * Branch authorization logic (Architecture doc §3.4). Must run after
 * `authenticate`. Extracts branch_id from request params, query, or body
 * (in that order):
 * - super_admin: skip the check entirely, access to all branches.
 * - supervisor: requested branch_id must be in the user's branch_ids array.
 * - staff: requested branch_id must equal the user's single assigned branch.
 * (An active-shift check for POS endpoints is a separate, route-specific
 * middleware — not duplicated here.)
 */
export function branchGuard(req: Request, res: Response, next: NextFunction): void {
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

  if (!req.user.branch_ids.includes(branchId)) {
    res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
    return;
  }

  next();
}
