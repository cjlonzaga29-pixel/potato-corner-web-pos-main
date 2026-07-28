import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createInventoryCategorySchema,
  updateInventoryCategorySchema,
  createUnitOfMeasureSchema,
  updateUnitOfMeasureSchema,
  createUnitConversionSchema,
  createInventoryItemSchema,
  updateInventoryItemSchema,
  assignInventoryItemToBranchesSchema,
} from '@potato-corner/shared';
import { universalInventoryService } from './universal-inventory.service.js';
import { UniversalInventoryError } from './universal-inventory.types.js';
import { runMigrationDryRun } from '../inventory-migration/dry-run.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const includeInactiveQuerySchema = z.object({
  include_inactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

/** Routes UniversalInventoryError to its declared status code; unexpected errors fall through to the global handler. */
function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof UniversalInventoryError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// R9 — Universal Inventory identity (categories/units/conversions/items,
// and which branches an item is assigned to) is Admin/Super Admin owned.
// Supervisors get read access for oversight, same posture as
// product-inventory's GET /. Branches have no access here — CR-010 keeps
// branch stock operations on the existing legacy Ingredient endpoints
// (apps/api/src/modules/inventory) unchanged.

// --- Inventory Categories ---

router.get('/categories', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = includeInactiveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const categories = await universalInventoryService.listCategories(parsed.data.include_inactive ?? false);
    res.status(200).json({ data: { categories }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/categories',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(createInventoryCategorySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const category = await universalInventoryService.createCategory(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(201).json({ data: category, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/categories/:categoryId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateInventoryCategorySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const category = await universalInventoryService.updateCategory(
        req.params.categoryId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: category, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// --- Units of measure ---

router.get('/units', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = includeInactiveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const units = await universalInventoryService.listUnits(parsed.data.include_inactive ?? false);
    res.status(200).json({ data: { units }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/units',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(createUnitOfMeasureSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const unit = await universalInventoryService.createUnit(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(201).json({ data: unit, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/units/:unitId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateUnitOfMeasureSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const unit = await universalInventoryService.updateUnit(
        req.params.unitId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: unit, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// --- Unit conversions ---

router.get('/conversions', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const conversions = await universalInventoryService.listConversions();
    res.status(200).json({ data: { conversions }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/conversions',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(createUnitConversionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const conversion = await universalInventoryService.createConversion(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(201).json({ data: conversion, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// --- Inventory items (universal identity) ---

router.get('/items', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = includeInactiveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const items = await universalInventoryService.listItems(parsed.data.include_inactive ?? false);
    res.status(200).json({ data: { items }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/items/:itemId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const item = await universalInventoryService.getItemById(req.params.itemId as string);
    res.status(200).json({ data: item, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/items',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(createInventoryItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const item = await universalInventoryService.createItem(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(201).json({ data: item, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/items/:itemId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateInventoryItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const item = await universalInventoryService.updateItem(
        req.params.itemId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: item, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// --- Branch assignment (R2 — Admin assigns which branches carry an item) ---

router.post(
  '/items/:itemId/branches',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(assignInventoryItemToBranchesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await universalInventoryService.assignToBranches(
        req.params.itemId as string,
        req.body.branch_ids,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// --- Legacy migration report (R6/R11 — read-only, no auto-migration/apply) ---

router.get('/migration-report', authenticate, adminOnly, requirePasswordChange, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await runMigrationDryRun();
    res.status(200).json({ data: report, error: null, meta: null });
  } catch (error) {
    next(error);
  }
});

export { router as universalInventoryRouter };
