import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  createInventoryCategorySchema,
  updateInventoryCategorySchema,
  createUnitOfMeasureSchema,
  updateUnitOfMeasureSchema,
  createUnitConversionSchema,
  createInventoryItemUnitConversionSchema,
  updateInventoryItemUnitConversionSchema,
  createInventoryItemSchema,
  updateInventoryItemSchema,
  assignInventoryItemToBranchesSchema,
  receiveInventoryStockSchema,
  adjustInventoryStockSchema,
  wasteInventoryStockSchema,
  transferInventoryStockSchema,
  physicalCountInventoryStockSchema,
  createInventoryCostCorrectionSchema,
} from '@potato-corner/shared';
import { universalInventoryService } from './universal-inventory.service.js';
import { UniversalInventoryError } from './universal-inventory.types.js';
import type { InventoryStockMovementType } from './universal-inventory.types.js';
import { runMigrationDryRun } from '../inventory-migration/dry-run.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, adminSupervisorOrBranch } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';
import { resolveDateRangeBoundary } from '../../lib/manila-time.js';

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new UniversalInventoryError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

/** Shared multer-error-to-JSON translation for the proof-upload routes below — mirrors expensesRouter's receiptUpload wiring. */
function handleUpload(uploader: (req: Request, res: Response, callback: (error?: unknown) => void) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    uploader(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(
          error instanceof multer.MulterError ? new UniversalInventoryError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422) : error,
          res,
          next,
        );
        return;
      }
      next();
    });
  };
}

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
      const body = req.body as z.infer<typeof createInventoryItemSchema>;
      const item = await universalInventoryService.createItem(
        {
          name: body.name,
          sku: body.sku,
          barcode: body.barcode,
          categoryId: body.category_id,
          baseUnitId: body.base_unit_id,
          trackInventory: body.track_inventory,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
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
      const body = req.body as z.infer<typeof updateInventoryItemSchema>;
      const item = await universalInventoryService.updateItem(
        req.params.itemId as string,
        {
          name: body.name,
          sku: body.sku,
          barcode: body.barcode,
          categoryId: body.category_id,
          trackInventory: body.track_inventory,
        },
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

// --- Item-specific unit conversions (TASK 121 — reuses TASK 115's service/repository) ---

// Receiving Simplification V2 §3: branch staff need read (never write)
// access to an item's configured purchase-unit conversions to populate the
// receiving form's Purchase Unit dropdown — "Admin only [to write]. Supervisor
// may view. Branch uses the configured purchase units." Write endpoints
// below stay adminOnly.
router.get(
  '/items/:itemId/conversions',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const conversions = await universalInventoryService.listItemConversions(req.params.itemId as string);
      res.status(200).json({ data: { conversions }, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/items/:itemId/conversions',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(createInventoryItemUnitConversionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof createInventoryItemUnitConversionSchema>;
      const conversion = await universalInventoryService.createItemConversion(
        {
          inventoryItemId: req.params.itemId as string,
          fromUnitId: body.from_unit_id,
          toUnitId: body.to_unit_id,
          factor: body.factor,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: conversion, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/items/:itemId/conversions/:conversionId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateInventoryItemUnitConversionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof updateInventoryItemUnitConversionSchema>;
      const conversion = await universalInventoryService.updateItemConversion(
        req.params.itemId as string,
        req.params.conversionId as string,
        { factor: body.factor },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: conversion, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete(
  '/items/:itemId/conversions/:conversionId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await universalInventoryService.deleteItemConversion(
        req.params.itemId as string,
        req.params.conversionId as string,
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

// ---------------------------------------------------------------------------
// Branch inventory cutover — direct InventoryStock read/write, replacing the
// legacy Ingredient-based branch inventory endpoints (apps/api/src/modules/
// inventory) as the active branch supply-side workflow. Mounted at
// /api/branches, alongside inventoryBranchRouter (which is left in place,
// unmodified, for historical/back-compat reads only — see the migration
// cutover report for what still calls it).
// ---------------------------------------------------------------------------

const stockBranchRouter: Router = Router();

const stockMovementTypeValues = [
  'RECEIVING',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'WASTE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'PHYSICAL_COUNT',
  'SALE',
  'SALE_REVERSAL',
] as const;

// from_date/to_date accept either a bare Manila business date (YYYY-MM-DD,
// widened server-side via resolveDateRangeBoundary) or an already-precise
// ISO datetime — same union as inventory.router.ts's movementsQuerySchema
// and reports.schema.ts's ReportFiltersSchema. Previously z.iso.datetime()-only,
// which rejected the bare date the Stock Movement page's date filter sends,
// surfacing as a 422 ("Something went wrong") whenever a date range was set.
const stockMovementsQuerySchema = z.object({
  inventory_item_id: z.uuid().optional(),
  movement_type: z.enum(stockMovementTypeValues).optional(),
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

stockBranchRouter.get(
  '/:branchId/inventory-stock',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await universalInventoryService.getBranchStock(req.params.branchId as string);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.get(
  '/:branchId/inventory-stock/alerts',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await universalInventoryService.getBranchStockAlerts(req.params.branchId as string);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.get(
  '/:branchId/inventory-stock/movements',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const parsed = stockMovementsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          data: null,
          error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
          meta: null,
        });
        return;
      }
      const result = await universalInventoryService.getStockMovements(req.params.branchId as string, {
        inventoryItemId: parsed.data.inventory_item_id,
        movementType: parsed.data.movement_type as InventoryStockMovementType | undefined,
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

stockBranchRouter.post(
  '/:branchId/inventory-stock/:inventoryItemId/receive',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  validate(receiveInventoryStockSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof receiveInventoryStockSchema>;
      const result = await universalInventoryService.receiveStock(
        {
          branchId: req.params.branchId as string,
          inventoryItemId: req.params.inventoryItemId as string,
          quantity: body.quantity,
          totalCost: body.total_cost,
          enteredUnitId: body.entered_unit_id,
          deliveryReference: body.delivery_reference,
          notes: body.notes,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.post(
  '/:branchId/inventory-stock/:inventoryItemId/adjust',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  validate(adjustInventoryStockSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof adjustInventoryStockSchema>;
      const result = await universalInventoryService.adjustStock(
        {
          branchId: req.params.branchId as string,
          inventoryItemId: req.params.inventoryItemId as string,
          quantityDelta: body.quantity_delta,
          reasonCode: body.reason_code,
          notes: body.notes,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.post(
  '/:branchId/inventory-stock/:inventoryItemId/waste',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  validate(wasteInventoryStockSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof wasteInventoryStockSchema>;
      const result = await universalInventoryService.wasteStock(
        {
          branchId: req.params.branchId as string,
          inventoryItemId: req.params.inventoryItemId as string,
          quantity: body.quantity,
          enteredUnitId: body.entered_unit_id,
          reasonCode: body.reason_code,
          responsibleUserId: body.responsible_user_id,
          notes: body.notes,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.get(
  '/:branchId/inventory-stock/transfer-destinations',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await universalInventoryService.getTransferDestinations(req.params.branchId as string, {
        id: req.user.user_id,
        role: req.user.role,
      });
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.post(
  '/:branchId/inventory-stock/transfer',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  validate(transferInventoryStockSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof transferInventoryStockSchema>;
      const result = await universalInventoryService.transferStock(
        {
          fromBranchId: req.params.branchId as string,
          toBranchId: body.to_branch_id,
          inventoryItemId: body.inventory_item_id,
          quantity: body.quantity,
          notes: body.notes,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.post(
  '/:branchId/inventory-stock/count',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  validate(physicalCountInventoryStockSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof physicalCountInventoryStockSchema>;
      const result = await universalInventoryService.submitPhysicalCount(
        {
          branchId: req.params.branchId as string,
          counts: body.counts.map((c) => ({ inventoryItemId: c.inventory_item_id, countedQuantity: c.counted_quantity })),
          notes: body.notes,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// ---------------------------------------------------------------------------
// Receiving/waste proof photo (Receiving Simplification V2 §7-8). Two-step,
// mirrors expensesRouter's POST /:expenseId/receipt: the movement already
// exists (created by /receive or /waste above) before a photo is attached.
// Optional on both RECEIVING and WASTE — no upload-required check here.
// ---------------------------------------------------------------------------

stockBranchRouter.post(
  '/:branchId/inventory-stock/movements/:movementId/proof',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  handleUpload(proofUpload.single('proof')),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A proof image file is required' }, meta: null });
        return;
      }
      const result = await universalInventoryService.uploadMovementProof(
        req.params.branchId as string,
        req.params.movementId as string,
        { buffer: req.file.buffer, originalname: req.file.originalname },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.get(
  '/:branchId/inventory-stock/movements/:movementId/proof-url',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await universalInventoryService.getMovementProofUrl(req.params.branchId as string, req.params.movementId as string);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// ---------------------------------------------------------------------------
// Cost correction (Receiving Simplification V2 §12-15). adminOrSupervisor
// only — Branch Accounts get no access to any correction route, matching
// "Branch Account: NO cost correction permission unless current RBAC
// explicitly allows it" (it doesn't). branchGuard still applies so a
// supervisor is limited to their assigned branches, same as every other
// stockBranchRouter route.
// ---------------------------------------------------------------------------

stockBranchRouter.post(
  '/:branchId/inventory-stock/:inventoryItemId/cost-corrections',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  validate(createInventoryCostCorrectionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof createInventoryCostCorrectionSchema>;
      const result = await universalInventoryService.correctCost(
        {
          branchId: req.params.branchId as string,
          inventoryItemId: req.params.inventoryItemId as string,
          newUnitCost: body.new_unit_cost,
          reasonCode: body.reason_code,
          notes: body.notes,
        },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

const costCorrectionQuerySchema = z.object({
  inventory_item_id: z.uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

stockBranchRouter.get(
  '/:branchId/inventory-stock/cost-corrections',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const parsed = costCorrectionQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          data: null,
          error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
          meta: null,
        });
        return;
      }
      const result = await universalInventoryService.listCostCorrections(req.params.branchId as string, {
        inventoryItemId: parsed.data.inventory_item_id,
        page: parsed.data.page,
        limit: parsed.data.limit,
      });
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

stockBranchRouter.post(
  '/:branchId/inventory-stock/cost-corrections/:correctionId/proof',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  handleUpload(proofUpload.single('proof')),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A proof image file is required' }, meta: null });
        return;
      }
      const result = await universalInventoryService.uploadCostCorrectionProof(
        req.params.branchId as string,
        req.params.correctionId as string,
        { buffer: req.file.buffer, originalname: req.file.originalname },
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as universalInventoryRouter, stockBranchRouter as inventoryStockBranchRouter };
