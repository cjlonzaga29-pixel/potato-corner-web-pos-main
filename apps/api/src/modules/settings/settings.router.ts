import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  updateSecurityPolicySchema,
  updateNotificationPreferencesSchema,
  updateReceiptConfigSchema,
  updatePaymentMethodConfigSchema,
  updateDiscountPolicySchema,
  updateWorkHoursPolicySchema,
  updateWriteGateSchema,
} from '@potato-corner/shared';
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

/**
 * Task 209.xx — GET is `allRoles`: cashier/staff and the Branch Account must
 * be able to read the configured percentages so the POS discount dropdown
 * can render "PWD (10%)" etc. (requirement: Cashier/Staff and Branch Account
 * are READ ONLY). PUT is `adminOrSupervisor`: only a Supervisor or Super
 * Admin may change a rate — matches adminOrSupervisor's existing precedent
 * (authorize.ts) for regional-oversight-level settings.
 */
router.get('/discount-policy', authenticate, allRoles, requirePasswordChange, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await settingsService.getDiscountPolicy();
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
