import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  createPromotionSchema,
  updatePromotionSchema,
  setPromotionEnabledSchema,
  promotionListQuerySchema,
  createManualDiscountTypeSchema,
  updateManualDiscountTypeSchema,
  deactivateManualDiscountTypeSchema,
  manualDiscountTypeListQuerySchema,
  MANUAL_DISCOUNT_POS_CAPABILITY,
  ROLES,
  type CreateManualDiscountTypeInput,
  type UpdateManualDiscountTypeInput,
  type DeactivateManualDiscountTypeInput,
  type CreatePromotionInput,
  type UpdatePromotionInput,
  type SetPromotionEnabledInput,
} from '@potato-corner/shared';
import { discountsService, manualDiscountTypesService } from './discounts.service.js';
import { DiscountError } from './discounts.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, allRoles, supervisorOnly } from '../../middleware/authorize.js';
import { requireActiveEmployee, requireActiveSupervisor } from '../../middleware/require-active-employee.js';
import { hasBranchAccess } from '../../lib/branch-access.js';
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

// POS-PERF-P55 — manual peso discount types. Reads: super_admin (everything,
// read-only) and supervisors (their live branches). Writes: supervisors only,
// re-checked against live branch authority in manualDiscountTypesService.
// /manual-types/pos is the terminal's offer list for its own branch.
router.get('/manual-types', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = manualDiscountTypeListQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid query', details: query.error.issues }, meta: null });
      return;
    }
    const types = await manualDiscountTypesService.list(req.user, query.data.branch_id, query.data.include_inactive);
    res.status(200).json({ data: types, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// Registered before /manual-types/:typeId routes so "pos" is never captured as an id.
router.get(
  '/manual-types/pos',
  authenticate,
  allRoles,
  requireActiveEmployee,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      // Staff and Branch Account tokens pin their branch: a query branch_id is
      // ignored for them (same rule as GET /settings/discount-policy).
      let branchId: string | undefined;
      if (req.user.role === ROLES.STAFF || req.user.role === ROLES.BRANCH) {
        branchId = req.user.branch_ids[0];
      } else {
        const query = manualDiscountTypeListQuerySchema.safeParse(req.query);
        branchId = query.success ? query.data.branch_id : undefined;
        if (branchId && !(await hasBranchAccess(req.user, branchId))) {
          res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED', message: 'You do not have access to this branch' }, meta: null });
          return;
        }
      }
      if (!branchId) {
        res.status(422).json({ data: null, error: { code: 'BRANCH_REQUIRED', message: 'branch_id is required' }, meta: null });
        return;
      }
      const types = await manualDiscountTypesService.listForPos(branchId, req.query.capabilities === MANUAL_DISCOUNT_POS_CAPABILITY);
      res.status(200).json({ data: types, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/manual-types',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(createManualDiscountTypeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const type = await manualDiscountTypesService.create(req.user, req.body as CreateManualDiscountTypeInput, req.ip ?? null);
      res.status(201).json({ data: type, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/manual-types/:typeId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(updateManualDiscountTypeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const type = await manualDiscountTypesService.update(req.user, req.params.typeId as string, req.body as UpdateManualDiscountTypeInput, req.ip ?? null);
      res.status(200).json({ data: type, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/manual-types/:typeId/deactivate',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(deactivateManualDiscountTypeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const type = await manualDiscountTypesService.deactivate(
        req.user,
        req.params.typeId as string,
        req.body as DeactivateManualDiscountTypeInput,
        req.ip ?? null,
      );
      res.status(200).json({ data: type, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as discountsRouter };
