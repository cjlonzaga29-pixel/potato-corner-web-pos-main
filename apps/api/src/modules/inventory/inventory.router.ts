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
  type MovementType,
} from '@potato-corner/shared';
import { inventoryService } from './inventory.service.js';
import { IngredientError } from './inventory.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, adminSupervisorOrBranch } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';
import { hasBranchAccess } from '../../lib/branch-access.js';
import { resolveDateRangeBoundary } from '../../lib/manila-time.js';

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

/**
 * POS-PERF-P29R5 — these four legacy LEGACY_INGREDIENT mutation routes
 * (stock-in/adjust/waste on /ingredients/:id, physical count on
 * /branches/:branchId/inventory/count) predate P29/CR-001 and never
 * collected a verification_token/evidence_key. The approval-queue branch
 * added for the MANUAL_INVENTORY_APPROVAL_REQUIRED flag papered over that —
 * an approval queue is not the same as the responsible-staff-identity +
 * evidence policy itself, so a request without either was still a policy
 * bypass, just a reviewed one. CR-001/Universal Inventory fully superseded
 * this surface (apps/web has zero remaining callers of
 * useStockIn/useAdjustIngredient/useWasteIngredient/useSubmitPhysicalCount
 * in hooks/queries/use-inventory.ts — every branch-ops form now posts
 * through use-universal-inventory.ts instead), so rather than retrofit PIN
 * capture onto a dead code path, these routes are retired outright: no
 * stock write, no approval request, regardless of the kill-switch state.
 */
function rejectRetiredLegacyMutation(res: Response, universalPath: string): void {
  res.status(410).json({
    data: null,
    error: {
      code: 'LEGACY_INVENTORY_MUTATION_RETIRED',
      message: `This legacy ingredient endpoint no longer accepts writes. Use the Universal Inventory workflow instead: POST /api/branches/:branchId/${universalPath}.`,
    },
    meta: null,
  });
}

// ---------------------------------------------------------------------------
// Ingredient master data + single-ingredient stock operations
// Mounted at /api/inventory
// ---------------------------------------------------------------------------

const inventoryRouter: Router = Router();

inventoryRouter.get(
  '/ingredients',
  authenticate,
  adminSupervisorOrBranch,
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
  adminSupervisorOrBranch,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const ingredient = await inventoryService.getIngredientById(req.params.id as string);
      // branchGuard itself can't be used here — it extracts branchId from
      // params/query/body, and this route only has an ingredient id in the
      // URL. The branch to check is only known once the ingredient has been
      // fetched, so the same allow/deny rule is applied inline instead.
      if (!(await hasBranchAccess(req.user, ingredient.branch_id))) {
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
  adminOrSupervisor,
  requirePasswordChange,
  validate(createIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { branch_id: string };
      if (!(await hasBranchAccess(req.user, body.branch_id))) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_NOT_ASSIGNED' }, meta: null });
        return;
      }
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
  // Ingredient field updates (reorder point, unit, etc.) are day-to-day
  // inventory ops, unlike create/delete which stay HQ-only master-data
  // control — grouped with list/stock-in/adjust/waste below.
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(updateIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      let existing;
      try {
        existing = await inventoryService.getIngredientById(req.params.id as string);
      } catch (error) {
        return handleModuleError(error, res, next);
      }
      if (!(await hasBranchAccess(req.user, existing.branch_id))) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_NOT_ASSIGNED' }, meta: null });
        return;
      }
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
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(stockInSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      rejectRetiredLegacyMutation(res, 'inventory-stock/:inventoryItemId/receive');
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.post(
  '/ingredients/:id/adjust',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(adjustIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      rejectRetiredLegacyMutation(res, 'inventory-stock/:inventoryItemId/adjust');
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryRouter.post(
  '/ingredients/:id/waste',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(wasteIngredientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      rejectRetiredLegacyMutation(res, 'inventory-stock/:inventoryItemId/waste');
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

// from_date/to_date accept either a bare Manila business date (YYYY-MM-DD,
// widened server-side via resolveDateRangeBoundary) or an already-precise
// ISO datetime — same union as reports.schema.ts's ReportFiltersSchema.
const movementsQuerySchema = z.object({
  ingredient_id: z.uuid().optional(),
  movement_type: z.enum(movementTypeValues).optional(),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

inventoryBranchRouter.get(
  '/:branchId/inventory',
  authenticate,
  adminSupervisorOrBranch,
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
  adminSupervisorOrBranch,
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
  adminSupervisorOrBranch,
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
        fromDate: parsed.data.from_date ? resolveDateRangeBoundary(parsed.data.from_date, 'start') : undefined,
        toDate: parsed.data.to_date ? resolveDateRangeBoundary(parsed.data.to_date, 'end') : undefined,
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
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  validate(physicalCountSubmissionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      rejectRetiredLegacyMutation(res, 'inventory-stock/count');
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

inventoryBranchRouter.post(
  '/:branchId/inventory/transfer',
  authenticate,
  adminSupervisorOrBranch,
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
