import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  ROLES,
  updateSecurityPolicySchema,
  updateNotificationPreferencesSchema,
  updateReceiptConfigSchema,
  updatePaymentMethodConfigSchema,
} from '@potato-corner/shared';
import { settingsService } from './settings.service.js';
import { SettingsError } from './settings.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminSupervisorOrBranch } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

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

branchReceiptConfigRouter.get(
  '/:branchId/receipt-config',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = req.params.branchId as string;
      if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(branchId)) {
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
