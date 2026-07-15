import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createIngredientSchema,
  updateIngredientSchema,
  stockInSchema,
  adjustIngredientSchema,
  wasteIngredientSchema,
  transferIngredientSchema,
  physicalCountSubmissionSchema,
  MOVEMENT_TYPE,
  ROLES,
  type MovementType,
} from '@potato-corner/shared';
import { inventoryService } from './inventory.service.js';
import { IngredientError } from './inventory.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const movementTypeValues = Object.values(MOVEMENT_TYPE) as [MovementType, ...MovementType[]];

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

// ---------------------------------------------------------------------------
// Ingredient master data + single-ingredient stock operations
// Mounted at /api/inventory
// ---------------------------------------------------------------------------

const inventoryRouter: Router = Router();

inventoryRouter.get(
  '/ingredients',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : undefined;
      const result = await inventoryService.listIngredients(branchId);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.get(
  '/ingredients/:id',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const ingredient = await inventoryService.getIngredientById(req.params.id as string);
      // branchGuard itself can't be used here — it extracts branchId from
      // params/query/body, and this route only has an ingredient id in the
      // URL. The branch to check is only known once the ingredient has been
      // fetched, so the same allow/deny rule is applied inline instead.
      if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(ingredient.branch_id)) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
      res.status(200).json({ data: ingredient, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.post(
  '/ingredients',
  authenticate,
  adminOnly,
  requirePasswordChange,
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

inventoryRouter.patch(
  '/ingredients/:id',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const ingredient = await inventoryService.updateIngredient(
        req.params.id as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: ingredient, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.delete(
  '/ingredients/:id',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      await inventoryService.deleteIngredient(req.params.id as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(204).send();
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.post(
  '/ingredients/:id/stock-in',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(stockInSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const movement = await inventoryService.stockIn(
        req.params.id as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: movement, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.post(
  '/ingredients/:id/adjust',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(adjustIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const movement = await inventoryService.adjustIngredient(
        req.params.id as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: movement, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.post(
  '/ingredients/:id/waste',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(wasteIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const movement = await inventoryService.wasteIngredient(
        req.params.id as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: movement, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// ---------------------------------------------------------------------------
// Branch-scoped stock views and operations
// Mounted at /api/branches (alongside branchesRouter, which owns /:branchId
// and its own sub-paths — no overlap, Express falls through to this router
// for anything under /:branchId/inventory*)
// ---------------------------------------------------------------------------

const inventoryBranchRouter: Router = Router();

const movementsQuerySchema = z.object({
  ingredient_id: z.uuid().optional(),
  movement_type: z.enum(movementTypeValues).optional(),
  from_date: z.iso.datetime().optional(),
  to_date: z.iso.datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

inventoryBranchRouter.get(
  '/:branchId/inventory',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await inventoryService.getBranchInventory(req.params.branchId as string);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryBranchRouter.get(
  '/:branchId/inventory/alerts',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await inventoryService.getBranchAlerts(req.params.branchId as string);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryBranchRouter.get(
  '/:branchId/inventory/movements',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const parsed = movementsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          data: null,
          error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
          meta: null,
        });
        return;
      }
      const result = await inventoryService.getMovements(req.params.branchId as string, {
        ingredientId: parsed.data.ingredient_id,
        movementType: parsed.data.movement_type,
        fromDate: parsed.data.from_date ? new Date(parsed.data.from_date) : undefined,
        toDate: parsed.data.to_date ? new Date(parsed.data.to_date) : undefined,
        page: parsed.data.page,
        limit: parsed.data.limit,
      });
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryBranchRouter.post(
  '/:branchId/inventory/count',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  validate(physicalCountSubmissionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = req.params.branchId as string;
      const body = req.body as { branch_id: string };
      if (body.branch_id !== branchId) {
        res.status(400).json({ data: null, error: { code: 'BRANCH_ID_MISMATCH' }, meta: null });
        return;
      }
      const result = await inventoryService.submitPhysicalCount(
        branchId,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryBranchRouter.post(
  '/:branchId/inventory/transfer',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  validate(transferIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await inventoryService.transferStock(
        req.params.branchId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { inventoryRouter, inventoryBranchRouter };
