import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  createPromotionSchema,
  updatePromotionSchema,
  setPromotionEnabledSchema,
  promotionListQuerySchema,
  type CreatePromotionInput,
  type UpdatePromotionInput,
  type SetPromotionEnabledInput,
} from '@potato-corner/shared';
import { discountsService } from './discounts.service.js';
import { DiscountError } from './discounts.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, supervisorOnly } from '../../middleware/authorize.js';
import { requireActiveSupervisor } from '../../middleware/require-active-employee.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

/** Routes DiscountError to its declared status code; unexpected errors fall through to the global handler. */
function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof DiscountError) {
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

// POS-PERF-P49 — product-scoped promotions. Reads: super_admin (everything,
// read-only) and supervisors (promotions touching their live branches).
// Writes: supervisors only, re-validated against live branch authority and
// product eligibility in discountsService on every request.
router.get('/promotions', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = promotionListQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid query', details: query.error.issues }, meta: null });
      return;
    }
    const promotions = await discountsService.listPromotions(req.user, query.data.branch_id);
    res.status(200).json({ data: promotions, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// Registered before /promotions/:promotionId so "eligible-products" is never captured as an id.
router.get(
  '/promotions/eligible-products',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const products = await discountsService.listEligibleProducts(req.user);
      res.status(200).json({ data: products, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/promotions',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(createPromotionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const promotion = await discountsService.createPromotion(req.user, req.body as CreatePromotionInput, req.ip ?? null);
      res.status(201).json({ data: promotion, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.put(
  '/promotions/:promotionId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(updatePromotionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const promotion = await discountsService.updatePromotion(
        req.user,
        req.params.promotionId as string,
        req.body as UpdatePromotionInput,
        req.ip ?? null,
      );
      res.status(200).json({ data: promotion, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/promotions/:promotionId/enabled',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(setPromotionEnabledSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const promotion = await discountsService.setPromotionEnabled(
        req.user,
        req.params.promotionId as string,
        req.body as SetPromotionEnabledInput,
        req.ip ?? null,
      );
      res.status(200).json({ data: promotion, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as discountsRouter };
