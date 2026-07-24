import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { openShiftSchema, closeShiftSchema, approveVarianceSchema, voidShiftSchema, ROLES } from '@potato-corner/shared';
import { cashService } from './cash.service.js';
import { CashError } from './cash.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, adminSupervisorOrBranch, allRoles } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof CashError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

const listQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  status: z.enum(['active', 'closed', 'flagged']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

router.post(
  '/open',
  authenticate,
  // CR-003: staff and branch both run POS shifts day to day — was
  // adminOrSupervisor pre-CR-003 (opening a shift on a cashier's behalf),
  // widened to allRoles to match GET /current and GET /:shiftId which are
  // already self-service for every role.
  allRoles,
  requirePasswordChange,
  branchGuard,
  validate(openShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { branch_id: string; cashier_id: string; starting_cash: number; denominations: { denomination: number; quantity: number }[] };
      const shift = await cashService.openShift(
        {
          branchId: body.branch_id,
          cashierId: body.cashier_id,
          openedBy: req.user.user_id,
          startingCash: body.starting_cash,
          denominations: body.denominations,
        },
        req.ip ?? null,
      );
      res.status(201).json({ data: shift, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get('/current', authenticate, allRoles, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchId = (req.query.branch_id as string | undefined) ?? (req.query.branchId as string | undefined);
    if (!branchId) {
      res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
      return;
    }
    const shift = await cashService.getCurrentShift(branchId);
    res.status(200).json({ data: shift, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await cashService.listShifts({
      branchId: parsed.data.branch_id,
      status: parsed.data.status,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:shiftId', authenticate, allRoles, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const shift = await cashService.getShiftById(req.params.shiftId as string);
    // branchGuard can't run here — it extracts branchId from params/query/body,
    // and this route only has a shift id in the URL. The branch to check is
    // only known once the shift has been fetched, so the same allow/deny
    // rule is applied inline instead (same pattern as GET /ingredients/:id).
    if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(shift.branch_id)) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    res.status(200).json({ data: shift, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:shiftId/summary', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await cashService.getShiftSummary(req.params.shiftId as string);
    // Same inline branch-check pattern as GET /:shiftId — the branch is only
    // known once the shift has been fetched.
    if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(result.shift.branch_id)) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:shiftId/close',
  authenticate,
  // See /open above — same allRoles rationale.
  allRoles,
  requirePasswordChange,
  validate(closeShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { denominations: { denomination: number; quantity: number }[]; notes?: string; variance_explanation?: string };
      const shift = await cashService.closeShift(
        req.params.shiftId as string,
        { denominations: body.denominations, notes: body.notes, varianceExplanation: body.variance_explanation },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: shift, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:shiftId/approve-variance',
  authenticate,
  // CR-003: variance approval is an oversight/approval action — supervisor
  // gains it alongside super_admin, not branch (branch is the operational
  // role being reviewed, not the reviewer).
  adminOrSupervisor,
  requirePasswordChange,
  validate(approveVarianceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { approved: boolean; notes: string };
      const shift = await cashService.approveVariance(
        req.params.shiftId as string,
        body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: shift, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:shiftId/void',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(voidShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { reason?: string };
      const shift = await cashService.voidShift(
        req.params.shiftId as string,
        body.reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: shift, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as cashRouter };
