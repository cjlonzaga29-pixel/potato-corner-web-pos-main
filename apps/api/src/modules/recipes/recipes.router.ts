import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createRecipeSchema,
  updateRecipeSchema,
  createRecipeOverrideSchema,
  updateRecipeOverrideSchema,
  simulateDeductionSchema,
  ROLES,
} from '@potato-corner/shared';
import { recipesService } from './recipes.service.js';
import { RecipeError } from './recipes.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminSupervisorOrBranch, branchOnly } from '../../middleware/authorize.js';
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
  if (error instanceof RecipeError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

const listQuerySchema = z.object({ product_variant_id: z.uuid() });

// --- Master recipes (Super Admin owns; Phase 7 foundation) ---

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const recipes = await recipesService.listRecipes(parsed.data.product_variant_id);
    res.status(200).json({ data: { recipes }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, adminOnly, requirePasswordChange, validate(createRecipeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const recipe = await recipesService.createRecipe(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: recipe, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:id', authenticate, adminOnly, requirePasswordChange, validate(updateRecipeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const recipe = await recipesService.updateRecipe(req.params.id as string, req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: recipe, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.delete('/:id', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await recipesService.deleteRecipe(req.params.id as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(204).send();
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// --- CR-001 deduction simulation ---

router.post('/simulate', authenticate, adminSupervisorOrBranch, requirePasswordChange, validate(simulateDeductionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const body = req.body as { branch_id?: string };
    // CR-003: was `=== ROLES.SUPERVISOR` — now that the router also admits
    // branch, this must scope any non-admin caller, not just supervisor.
    if (req.user.role !== ROLES.SUPER_ADMIN && body.branch_id && !req.user.branch_ids.includes(body.branch_id)) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    const result = await recipesService.simulateDeduction(req.body);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// --- CR-001 branch recipe overrides (supervisor, no approval, audit-logged) ---

router.get(
  '/:variantId/overrides',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = req.query.branch_id as string | undefined;
      if (!branchId) {
        res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
        return;
      }
      const overrides = await recipesService.listOverrides(req.params.variantId as string, branchId);
      res.status(200).json({ data: { overrides }, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:variantId/overrides',
  authenticate,
  branchOnly,
  requirePasswordChange,
  branchGuard,
  validate(createRecipeOverrideSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const override = await recipesService.createOverride(
        req.params.variantId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: override, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/overrides/:overrideId',
  authenticate,
  branchOnly,
  requirePasswordChange,
  branchGuard,
  validate(updateRecipeOverrideSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = req.query.branch_id as string | undefined;
      if (!branchId) {
        res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
        return;
      }
      const override = await recipesService.updateOverride(
        req.params.overrideId as string,
        branchId,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: override, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete(
  '/overrides/:overrideId',
  authenticate,
  branchOnly,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = req.query.branch_id as string | undefined;
      if (!branchId) {
        res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
        return;
      }
      await recipesService.deleteOverride(req.params.overrideId as string, branchId, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(204).send();
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as recipesRouter };
