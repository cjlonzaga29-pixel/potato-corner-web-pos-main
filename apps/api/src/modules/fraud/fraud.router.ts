import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  dismissFraudAlertSchema,
  escalateFraudAlertSchema,
  fraudAlertListQuerySchema,
  investigateFraudAlertSchema,
} from '@potato-corner/shared';
import { fraudService } from './fraud.service.js';
import { FraudError } from './fraud.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly } from '../../middleware/authorize.js';
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

function handleFraudError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof FraudError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// Every route: authenticate -> super_admin only -> requirePasswordChange.
// Fraud alert review is a Super Admin-exclusive workflow (Phase 17
// groundwork) — no supervisor/staff access at all, so branchGuard never
// applies here.
router.get('/', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = fraudAlertListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await fraudService.listAlerts({
      branchId: parsed.data.branch_id,
      status: parsed.data.status,
      severity: parsed.data.severity,
      alertType: parsed.data.alert_type,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleFraudError(error, res, next);
  }
});

router.get('/:id', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const alert = await fraudService.getAlertById(req.params.id as string);
    res.status(200).json({ data: alert, error: null, meta: null });
  } catch (error) {
    handleFraudError(error, res, next);
  }
});

router.post(
  '/:id/investigate',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(investigateFraudAlertSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { notes?: string };
      const alert = await fraudService.investigateAlert(req.params.id as string, req.user.user_id, { notes: body.notes });
      res.status(200).json({ data: alert, error: null, meta: null });
    } catch (error) {
      handleFraudError(error, res, next);
    }
  },
);

router.post(
  '/:id/dismiss',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(dismissFraudAlertSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { dismissal_reason: string };
      const alert = await fraudService.dismissAlert(req.params.id as string, req.user.user_id, {
        dismissalReason: body.dismissal_reason,
      });
      res.status(200).json({ data: alert, error: null, meta: null });
    } catch (error) {
      handleFraudError(error, res, next);
    }
  },
);

router.post(
  '/:id/escalate',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(escalateFraudAlertSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { notes?: string };
      const alert = await fraudService.escalateAlert(req.params.id as string, req.user.user_id, { notes: body.notes });
      res.status(200).json({ data: alert, error: null, meta: null });
    } catch (error) {
      handleFraudError(error, res, next);
    }
  },
);

export { router as fraudRouter };
