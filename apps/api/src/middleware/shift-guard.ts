import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import { cashRepository } from '../modules/cash/cash.repository.js';
import { cashService } from '../modules/cash/cash.service.js';
import { attendanceRepository } from '../modules/attendance/attendance.repository.js';
import { extractBranchId } from '../lib/request.js';

/**
 * POS transaction gate (Architecture doc §3.4, revised Phase 4-9 shift
 * removal). Must run after `authenticate` and `branchGuard`. super_admin and
 * supervisor are exempt (CR-003: supervisor is regional oversight and does
 * not run a physical register). `branch` and `staff` both operate the POS
 * Terminal directly.
 *
 * The gate is now attendance-based, not Shift-based: "clocked in at this
 * branch" is the single source of truth for "may this cashier transact",
 * matching the new Clock In -> Ready to Sell flow (no manual Open Shift
 * step). A Shift row is still resolved onto req.activeShift — HoldOrder and
 * Transaction still link to one — auto-created lazily here if clock-in
 * somehow didn't already create it, so checkout is never blocked by shift
 * bookkeeping the cashier never sees.
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

  const activeAttendance = await attendanceRepository.findActiveRecord(req.user.user_id);
  if (!activeAttendance || activeAttendance.branchId !== branchId) {
    res.status(403).json({ data: null, error: { code: 'NOT_CLOCKED_IN' }, meta: null });
    return;
  }

  let shift = await cashRepository.findActiveShift(req.user.user_id, branchId);
  if (!shift) {
    // autoOpenShift returns the public response DTO (like every other
    // cashService method), not the raw Prisma row req.activeShift expects —
    // re-fetch after the fact rather than trust its return shape here.
    await cashService.autoOpenShift({ branchId, cashierId: req.user.user_id }, null);
    shift = await cashRepository.findActiveShift(req.user.user_id, branchId);
  }

  req.activeShift = shift ?? undefined;
  next();
}
