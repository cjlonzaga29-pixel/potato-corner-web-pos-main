import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  updateSecurityPolicySchema,
  updateNotificationPreferencesSchema,
  updateReceiptConfigSchema,
  updatePaymentMethodConfigSchema,
  updateDiscountPolicySchema,
  updateBranchDiscountSettingsSchema,
  updateBranchTaxProfileSchema,
  updateWorkHoursPolicySchema,
  updateBranchWorkHoursSchema,
  updateWriteGateSchema,
} from '@potato-corner/shared';
import { z } from 'zod';
import { settingsService } from './settings.service.js';
import { SettingsError } from './settings.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, adminSupervisorOrBranch, allRoles } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';
import { hasBranchAccess } from '../../lib/branch-access.js';

const router: Router = Router();
const branchReceiptConfigRouter: Router = Router();

/** Routes SettingsError to its declared status code; unexpected errors fall through to the global handler. */
function handleSettingsError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof SettingsError) {
    res
      .status(error.statusCode)
      .json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

router.get('/security', authenticate, requirePasswordChange, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await settingsService.getSecurityPolicy();
    res.status(200).json({ data: policy, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.put(
  '/security',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateSecurityPolicySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const policy = await settingsService.updateSecurityPolicy(req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: policy, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

router.get(
  '/notifications',
  authenticate,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const preferences = await settingsService.getNotificationPreferences(req.user.user_id);
      res.status(200).json({ data: preferences, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

router.put(
  '/notifications',
  authenticate,
  requirePasswordChange,
  validate(updateNotificationPreferencesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const preferences = await settingsService.updateNotificationPreferences(req.user.user_id, req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: preferences, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

const branchQuerySchema = z.object({ branch_id: z.uuid().optional() });

/** Optional ?branch_id= (POS-PERF-P50R); 400 on a malformed id, undefined when absent. */
function readBranchQuery(req: Request, res: Response): { ok: true; branchId: string | undefined } | { ok: false } {
  const parsed = branchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid branch_id', details: parsed.error.issues }, meta: null });
    return { ok: false };
  }
  return { ok: true, branchId: parsed.data.branch_id };
}

/**
 * Task 209.xx — GET is `allRoles`: cashier/staff and the Branch Account must
 * be able to read the configured percentages so the POS discount dropdown
 * can render "PWD (20%)" etc. POS-PERF-P50R — a staff/branch caller always
 * gets its own branch's effective policy; others get the organization
 * default or ?branch_id=. PUT stays routed for adminOrSupervisor so an older
 * supervisor editor gets a clear 403 ORGANIZATION_DISCOUNTS_ADMIN_ONLY from
 * the service instead of a bare FORBIDDEN; only a Super Admin may save the
 * organization default.
 */
router.get('/discount-policy', authenticate, allRoles, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = readBranchQuery(req, res);
    if (!query.ok) return;
    const policy = await settingsService.getDiscountPolicyFor(req.user, query.branchId);
    res.status(200).json({ data: policy, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.put(
  '/discount-policy',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(updateDiscountPolicySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const policy = await settingsService.updateDiscountPolicy(req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: policy, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

/**
 * POS-PERF-P50 — read-only VAT/tax configuration, `allRoles` like
 * discount-policy: the POS and every settings page show it. There is no PUT
 * for the VAT rate, VAT-inclusive pricing or the PWD/Senior treatment: they
 * are statutory or fixed application behavior, changed only by a code
 * release. POS-PERF-P50R adds ?branch_id= and the branch VAT-registration
 * record below.
 */
router.get('/tax', authenticate, allRoles, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = readBranchQuery(req, res);
    if (!query.ok) return;
    const configuration = await settingsService.getTaxConfiguration(req.user, query.branchId);
    res.status(200).json({ data: configuration, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

const branchParamSchema = z.object({ branchId: z.uuid() });

/**
 * POS-PERF-P50R — one branch's discount settings. adminOrSupervisor; the
 * service re-checks a supervisor's live assignment to that branch on every
 * request (a forged branch id is 403, an unknown one 404).
 */
router.get('/discounts/branches/:branchId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const params = branchParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid branch id' }, meta: null });
      return;
    }
    const result = await settingsService.getBranchDiscountSettings(params.data.branchId, req.user);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.put(
  '/discounts/branches/:branchId',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(updateBranchDiscountSettingsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const params = branchParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid branch id' }, meta: null });
        return;
      }
      const result = await settingsService.updateBranchDiscountSettings(params.data.branchId, req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

/** POS-PERF-P50R — record a branch's VAT registration. Super Admin only (a legal fact the owner supplies). */
router.put(
  '/tax/branches/:branchId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateBranchTaxProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const params = branchParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid branch id' }, meta: null });
        return;
      }
      const result = await settingsService.updateBranchTaxProfile(params.data.branchId, req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

/**
 * P3D-P4 — GET is `allRoles` (mirrors discount-policy's precedent above):
 * the attendance UI needs the configured threshold to label Regular/OT
 * consistently for every role that can view attendance. PUT is `adminOnly`
 * per the spec's RBAC requirement — only Super Admin may change this global
 * threshold (unlike discount-policy's adminOrSupervisor).
 */
router.get('/work-hours', authenticate, allRoles, requirePasswordChange, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await settingsService.getWorkHoursPolicy();
    res.status(200).json({ data: policy, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.put(
  '/work-hours',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateWorkHoursPolicySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const policy = await settingsService.updateWorkHoursPolicy(req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: policy, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

/**
 * POS-PERF-P40 — per-branch Work Hours overrides. Supervisors manage only
 * branches they are actively assigned to (hasBranchAccess, database-sourced);
 * Super Admin keeps access to every branch. A write never touches the global
 * row or any other branch's row. The cross-branch list is Super Admin only
 * (read-only visibility on Admin Settings).
 */
const branchIdParamSchema = z.uuid();

async function resolveWorkHoursBranch(req: Request, res: Response): Promise<string | null> {
  if (!requireUser(req, res)) return null;
  const parsed = branchIdParamSchema.safeParse(req.params.branchId);
  if (!parsed.success) {
    res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'branchId must be a UUID' }, meta: null });
    return null;
  }
  if (!(await hasBranchAccess(req.user, parsed.data))) {
    res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
    return null;
  }
  return parsed.data;
}

router.get('/work-hours/branches', authenticate, adminOnly, requirePasswordChange, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await settingsService.listBranchWorkHours();
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.get('/work-hours/branches/:branchId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = await resolveWorkHoursBranch(req, res);
    if (!branchId) return;
    const result = await settingsService.getBranchWorkHours(branchId);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.put(
  '/work-hours/branches/:branchId',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(updateBranchWorkHoursSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = await resolveWorkHoursBranch(req, res);
      if (!branchId || !req.user) return;
      const result = await settingsService.setBranchWorkHours(branchId, req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

router.delete('/work-hours/branches/:branchId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = await resolveWorkHoursBranch(req, res);
    if (!branchId || !req.user) return;
    const result = await settingsService.clearBranchWorkHours(branchId, req.user, req.ip ?? null);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

/**
 * POS-PERF-P16 — operational write gate. adminOnly on both verbs: GET is
 * deliberately not allRoles/adminOrSupervisor like most read endpoints
 * above, because `activeGatedRequests` and `reason` are operational/
 * incident-response detail, not something every role needs to poll, and
 * because only a Super Admin should be have a reason to check whether this
 * is currently closed. PUT is the only place that can flip it — no public
 * or unauthenticated route exists anywhere that writes this key.
 */
router.get('/write-gate', authenticate, adminOnly, requirePasswordChange, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await settingsService.getWriteGate();
    res.status(200).json({ data: state, error: null, meta: null });
  } catch (error) {
    handleSettingsError(error, res, next);
  }
});

router.put(
  '/write-gate',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateWriteGateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const state = await settingsService.setWriteGate(req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: state, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

branchReceiptConfigRouter.get(
  '/:branchId/receipt-config',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = req.params.branchId as string;
      if (!(await hasBranchAccess(req.user, branchId))) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
      const config = await settingsService.getBranchReceiptConfig(branchId);
      res.status(200).json({ data: config, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

branchReceiptConfigRouter.put(
  '/:branchId/receipt-config',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(updateReceiptConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const config = await settingsService.updateBranchReceiptConfig(
        req.params.branchId as string,
        req.body,
        req.user,
        req.ip ?? null,
      );
      res.status(200).json({ data: config, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

branchReceiptConfigRouter.get(
  '/:branchId/payment-methods',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const config = await settingsService.getPaymentMethodConfig(req.params.branchId as string, req.user);
      res.status(200).json({ data: config, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

branchReceiptConfigRouter.put(
  '/:branchId/payment-methods',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(updatePaymentMethodConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const config = await settingsService.updatePaymentMethodConfig(
        req.params.branchId as string,
        req.body,
        req.user,
        req.ip ?? null,
      );
      res.status(200).json({ data: config, error: null, meta: null });
    } catch (error) {
      handleSettingsError(error, res, next);
    }
  },
);

export { router as settingsRouter, branchReceiptConfigRouter };
