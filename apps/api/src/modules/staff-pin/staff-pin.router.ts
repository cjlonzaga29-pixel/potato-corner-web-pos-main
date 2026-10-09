import { Router, type NextFunction, type Request, type Response } from 'express';
import { setStaffPinSchema, verifyStaffPinSchema } from '@potato-corner/shared';
import { staffPinService } from './staff-pin.service.js';
import { StaffPinError } from './staff-pin.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminSupervisorOrBranch } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { validate } from '../../middleware/validate.js';
import { staffPinVerifyFailureLimiter, staffPinVerifyOverallLimiter } from '../../middleware/rate-limiter.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof StaffPinError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

/**
 * POS-PERF-P29 — set or reset a staff member's PIN. super_admin may target
 * any staff; supervisor/branch are restricted to staff within their own
 * accessible branch (enforced in the service layer, not here, since it
 * needs the target's current branch assignment to check against). `staff`
 * role is deliberately absent from the allowed-roles list below: staff
 * accounts have no password/login at all (schema.prisma's User doc
 * comment), so a staff JWT is never the authenticated actor here — the
 * "self-service" path the design doc describes is a staff member entering
 * their own new PIN while a branch/supervisor session is already logged in
 * at the terminal, not a staff login session of their own.
 */
router.post(
  '/:userId/pin',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(setStaffPinSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await staffPinService.setPin(req.params.userId as string, (req.body as { pin: string }).pin, req.user, req.ip ?? null);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get('/:userId', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await staffPinService.getStatus(req.params.userId as string);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/:userId/pin/revoke', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await staffPinService.revokePin(req.params.userId as string, req.user, req.ip ?? null);
    res.status(200).json({ data: { revoked: true }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

/**
 * Verify a PIN for a draft inventory operation and mint a short-lived
 * verification token. Rate-limited per (branch, actor) by two independent
 * budgets — see rate-limiter.ts's staffPinVerifyFailureLimiter /
 * staffPinVerifyOverallLimiter doc comments: failed PINs alone trip the
 * tight lockout, while legitimate successive correct verifications only
 * count against the much looser overall cap.
 */
router.post(
  '/branches/:branchId/verify',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  // Resource cap first, deliberately: it must reject a request (429) BEFORE
  // the failure/lockout limiter's counter is ever touched. With the order
  // reversed, a request that the failure limiter let through but the
  // overall cap then rejected would finish with status 429 (>= 400) —
  // and since that's the status the failure limiter's own
  // `skipSuccessfulRequests` decrement logic inspects, it would treat a
  // perfectly valid, never-even-checked PIN attempt as a "failure" and
  // permanently consume one unit of the wrong-PIN brute-force budget.
  // Running the resource cap first means a request it rejects never
  // reaches the failure limiter at all, so it can never contaminate that
  // counter — only requests that genuinely reached the PIN check (and so
  // have an honest success/failure status) are ever counted there.
  staffPinVerifyOverallLimiter,
  staffPinVerifyFailureLimiter,
  validate(verifyStaffPinSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as {
        pin: string;
        operation: 'RECEIVING' | 'ADJUSTMENT' | 'PHYSICAL_COUNT' | 'WASTE';
        inventory_item_id?: string;
        quantity?: number;
        unit_id?: string;
        reason_code?: string;
        notes?: string;
      };
      const result = await staffPinService.verifyPin(
        {
          branchId: req.params.branchId as string,
          pin: body.pin,
          operation: body.operation,
          inventoryItemId: body.inventory_item_id,
          quantity: body.quantity,
          unitId: body.unit_id,
          reasonCode: body.reason_code,
          notes: body.notes,
        },
        req.user,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      // POS-PERF-P29R5 — marks this request for staffPinVerifyFailureLimiter's
      // requestWasSuccessful override (rate-limiter.ts) so ONLY a genuine
      // wrong-PIN rejection burns the brute-force budget. Every other error
      // this handler can throw (DB/storage failure, etc.) is a real failure
      // response to the caller but must not count against that budget —
      // validate(verifyStaffPinSchema)'s own 422 for a malformed draft never
      // reaches here at all, since it responds before this handler runs.
      if (error instanceof StaffPinError && error.code === 'INVALID_PIN') {
        res.locals.staffPinInvalid = true;
      }
      handleModuleError(error, res, next);
    }
  },
);

export { router as staffPinRouter };
