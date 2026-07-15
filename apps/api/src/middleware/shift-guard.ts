import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { cashRepository } from '../modules/cash/cash.repository.js';
import { extractBranchId } from '../lib/request.js';

/**
 * Active-shift gate for POS transaction endpoints (Architecture doc §3.4).
 * Must run after `authenticate` and `branchGuard`. super_admin and
 * supervisor are exempt — only staff must be clocked into an active shift
 * to transact.
 */
export async function shiftGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return;
  }

  if (req.user.role === ROLES.SUPER_ADMIN || req.user.role === ROLES.SUPERVISOR) {
    next();
    return;
  }

  const branchId = extractBranchId(req);
  if (!branchId) {
    res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
    return;
  }

  const shift = await cashRepository.findActiveShift(req.user.user_id, branchId);
  if (!shift) {
    res.status(403).json({ data: null, error: { code: 'NO_ACTIVE_SHIFT' }, meta: null });
    return;
  }

  req.activeShift = shift;
  next();
}
