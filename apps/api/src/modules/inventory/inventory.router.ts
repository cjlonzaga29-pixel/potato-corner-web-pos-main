import { Router, type NextFunction, type Request, type Response } from 'express';
import { createIngredientSchema } from '@potato-corner/shared';
import { inventoryService } from './inventory.service.js';
import { IngredientError } from './inventory.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
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
  if (error instanceof IngredientError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

/**
 * Ingredient master-data endpoints — the Phase 7 foundation CR-001's recipe
 * override work needs to reference real ingredients. Stock movements,
 * physical counts, and stock-in are Phase 8 scope and intentionally not here.
 */
router.get('/ingredients', authenticate, adminOrSupervisor, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : undefined;
    const result = await inventoryService.listIngredients(branchId);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/ingredients',
  authenticate,
  adminOnly,
  validate(createIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const ingredient = await inventoryService.createIngredient(
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: ingredient, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as inventoryRouter };
