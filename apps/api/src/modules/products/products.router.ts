import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  createProductSchema,
  updateProductSchema,
  changeProductStatusSchema,
  createVariantSchema,
  updateVariantSchema,
  linkVariantFlavorSchema,
  updateVariantFlavorSchema,
  bulkBranchProductAvailabilitySchema,
  assignVariantOptionGroupSchema,
  updateVariantOptionGroupSchema,
  publishProductSchema,
  unpublishProductSchema,
  forkProductToBranchSchema,
  cartAvailabilityCheckSchema,
  addFlavorSlotSchema,
  updateFlavorSlotSchema,
  reorderFlavorSlotsSchema,
  addSnackOptionSchema,
  PRODUCT_STATUS,
  type ProductStatus,
} from '@potato-corner/shared';
import { productsService, toFlavorSlotResponse } from './products.service.js';
import { ProductError } from './products.types.js';
import { FlavorError } from '../flavors/flavors.types.js';
import { flavorsService } from '../flavors/flavors.service.js';
import { productOptionsService } from '../product-options/product-options.service.js';
import { ProductOptionError } from '../product-options/product-options.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, allRoles, supervisorOnly } from '../../middleware/authorize.js';
import { branchGuard, branchGuardOptional } from '../../middleware/branch-guard.js';
import { requireActiveEmployee, requireActiveSupervisor } from '../../middleware/require-active-employee.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

// Task 209.6 — Product Image Management. Same limits/shape as
// expenses.router.ts's receiptUpload: 5MB cap, JPEG/PNG/WebP only.
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new ProductError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

const productStatusValues = Object.values(PRODUCT_STATUS) as [ProductStatus, ...ProductStatus[]];

const listQuerySchema = z.object({
  status: z.enum(productStatusValues).optional(),
  category: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  is_seasonal: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort_by: z.enum(['name', 'created_at', 'updated_at', 'display_order', 'status']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
});

const branchAvailabilityBodySchema = z.object({ is_available: z.boolean() });

// Phase D1 — Admin Readiness panel. branch_id accepts a specific branch uuid
// or the literal 'all' (read-only, cross-branch summary view).
const readinessQuerySchema = z.object({ branch_id: z.union([z.literal('all'), z.uuid()]) });

/** Routes ProductError/FlavorError to their declared status code; unexpected errors fall through to the global handler. */
function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ProductError || error instanceof FlavorError || error instanceof ProductOptionError) {
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

router.get('/', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await productsService.getAllProducts(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// Registered before /:productId — Express matches routes in order and
// "catalog" would otherwise be captured as a productId param.
router.get('/catalog', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchId = (req.query.branch_id as string | undefined) ?? (req.query.branchId as string | undefined);
    if (!branchId) {
      res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
      return;
    }
    const catalog = await productsService.getPosCatalog(branchId);
    res.status(200).json({ data: catalog, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// POS-PERF-P24 — cart-wide stock pre-check, fired at discrete cashier
// checkpoints (Add-ons/Mix & Max confirm, cart quantity +), never per
// keystroke. Two segments, so Express never confuses this with /:productId.
router.post(
  '/catalog/availability-check',
  authenticate,
  allRoles,
  requireActiveEmployee,
  requirePasswordChange,
  branchGuard,
  validate(cartAvailabilityCheckSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await productsService.checkCartAvailability(
        req.body.branch_id,
        req.body.lines.map((line: { product_variant_id: string; flavor_id?: string | null; selected_flavors?: { slot_index: number; snack_product_variant_id: string; flavor_id: string }[]; quantity: number }) => ({
          productVariantId: line.product_variant_id,
          flavorId: line.flavor_id ?? null,
          selectedFlavors: line.selected_flavors?.map((sf) => ({ slotIndex: sf.slot_index, snackProductVariantId: sf.snack_product_variant_id, flavorId: sf.flavor_id })),
          quantity: line.quantity,
        })),
      );
      res.status(200).json({
        data: { ok: result.ok, shortfalls: result.shortfalls.map((s) => ({ inventory_item_id: s.inventoryItemId, item_name: s.itemName, available: s.available, required: s.required })) },
        error: null,
        meta: null,
      });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get('/:productId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const product = await productsService.getProductById(req.params.productId as string, req.user);
    res.status(200).json({ data: product, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// POS-PERF-P34/P35 — product catalog management (create, edit, delete,
// configure) belongs to Supervisor alone now; super_admin keeps read-only/
// reporting access (every adminOrSupervisor GET in this router) but no
// write path. Branch/staff still cannot create products.
// Supervisor-specific scoping (e.g. exclusive_branch_id must be one of
// their own branches) is enforced in productsService.createProduct.
router.post('/', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(createProductSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const product = await productsService.createProduct(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: product, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:productId', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(updateProductSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const product = await productsService.updateProduct(
      req.params.productId as string,
      req.body,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: product, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.delete('/:productId', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await productsService.deleteProduct(req.params.productId as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(204).send();
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// Task 209.6 / POS-PERF-P35 — Product Image Management. Read mirrors GET
// /:productId (adminOrSupervisor). Upload/delete are Supervisor-only,
// scoped in the service layer to products the supervisor themselves
// created — same posture as every other product-identity write route
// (PATCH/DELETE /:productId above).

router.get('/:productId/image', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await productsService.getProductImage(req.params.productId as string);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:productId/image',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  (req: Request, res: Response, next: NextFunction) => {
    productImageUpload.single('image')(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(
          error instanceof multer.MulterError ? new ProductError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422) : error,
          res,
          next,
        );
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A product image file is required' }, meta: null });
        return;
      }
      const result = await productsService.uploadProductImage(
        req.params.productId as string,
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

router.delete('/:productId/image', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await productsService.deleteProductImage(req.params.productId as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch(
  '/:productId/status',
  authenticate,
  // changeProductStatusSchema's branch_id is optional — omitted it's a
  // global lifecycle change (POS-PERF-P35: supervisor-only now, ownership-
  // scoped in productsService.changeProductStatus), present it's a
  // branch-scoped status flip (branchGuard-checked below).
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(changeProductStatusSchema),
  branchGuardOptional,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const product = await productsService.changeProductStatus(
        req.params.productId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: product, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get(
  '/:productId/branch-availability',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const matrix = await productsService.getBranchAvailabilityMatrix(req.params.productId as string, {
        id: req.user.user_id,
        role: req.user.role,
      });
      res.status(200).json({ data: matrix, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:productId/branch-availability/bulk',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  branchGuard,
  validate(bulkBranchProductAvailabilitySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { updates } = req.body as { updates: { branch_id: string; is_available: boolean }[] };
      const result = await productsService.bulkUpdateBranchProductAvailability(
        req.params.productId as string,
        updates,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:productId/branch-availability/:branchId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  branchGuard,
  validate(branchAvailabilityBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { is_available } = req.body as { is_available: boolean };
      const row = await productsService.updateBranchProductAvailability(
        req.params.productId as string,
        req.params.branchId as string,
        is_available,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: row, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// Phase D1 — Readiness panel & product-level publish/unpublish. Read
// access mirrors branch-availability (adminOrSupervisor); publish/
// unpublish are supervisor-only writes (POS-PERF-P35) and branch-scoped,
// so they get branchGuard the same way the branch-availability PATCH
// routes above do.

router.get('/:productId/readiness', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = readinessQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const readiness = await productsService.getProductReadiness(req.params.productId as string, parsed.data.branch_id);
    res.status(200).json({ data: readiness, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:productId/publish',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(publishProductSchema),
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { branch_id } = req.body as { branch_id: string };
      const row = await productsService.publishProduct(
        req.params.productId as string,
        branch_id,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: row, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:productId/unpublish',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(unpublishProductSchema),
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { branch_id } = req.body as { branch_id: string };
      const row = await productsService.unpublishProduct(
        req.params.productId as string,
        branch_id,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: row, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// POS-PERF-P36R4 — scoped copy path: a supervisor who controls only some of
// a shared product's branches can no longer edit it in place (see
// catalog-authority.ts's full-coverage authority rule); this gives them a
// branch-exclusive copy of it, scoped to one branch they DO control.
// branchGuard enforces that branch_id is one the acting supervisor actually
// has an active assignment to — the service layer never re-derives that.
router.post(
  '/:productId/fork-to-branch',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(forkProductToBranchSchema),
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { branch_id } = req.body as { branch_id: string };
      const product = await productsService.forkProductForBranch(
        req.params.productId as string,
        branch_id,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: product, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// POS-PERF-P34R/P35 — variant CRUD, flavor linking, and option-group
// assignment are Supervisor-only product-configuration steps. Each is
// scoped in its service layer to products the acting supervisor themselves
// created (see products.service.ts / flavors.service.ts /
// product-options.service.ts) — never an arbitrary existing product.

router.post(
  '/:productId/variants',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(createVariantSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const variant = await productsService.createVariant(
        req.params.productId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: variant, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:productId/variants/:variantId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(updateVariantSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const variant = await productsService.updateVariant(
        req.params.productId as string,
        req.params.variantId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: variant, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete(
  '/:productId/variants/:variantId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      await productsService.deleteVariant(
        req.params.productId as string,
        req.params.variantId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(204).send();
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:productId/variants/:variantId/flavors',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(linkVariantFlavorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const link = await flavorsService.linkFlavorToVariant(
        req.params.productId as string,
        req.params.variantId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: link, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:productId/variants/:variantId/flavors/:flavorId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(updateVariantFlavorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const link = await flavorsService.updateVariantFlavor(
        req.params.productId as string,
        req.params.variantId as string,
        req.params.flavorId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: link, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// CR-008 R6 — Variant <-> Product Option Group assignment. Supervisor-only
// (POS-PERF-P34R/P35), ownership-scoped in productOptionsService to
// variants on a product they created. The Option Group/Option catalog
// itself lives in product-options.router.ts, also supervisor-only now.

router.get(
  '/:productId/variants/:variantId/option-groups',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const assignments = await productOptionsService.listVariantOptionGroups(req.params.productId as string, req.params.variantId as string);
      res.status(200).json({ data: { option_groups: assignments }, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:productId/variants/:variantId/option-groups',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(assignVariantOptionGroupSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const assignment = await productOptionsService.assignOptionGroupToVariant(
        req.params.productId as string,
        req.params.variantId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: assignment, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:productId/variants/:variantId/option-groups/:assignmentId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(updateVariantOptionGroupSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const assignment = await productOptionsService.updateVariantOptionGroup(
        req.params.productId as string,
        req.params.variantId as string,
        req.params.assignmentId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: assignment, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete(
  '/:productId/variants/:variantId/option-groups/:assignmentId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      await productOptionsService.unassignOptionGroupFromVariant(
        req.params.productId as string,
        req.params.variantId as string,
        req.params.assignmentId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(204).send();
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// POS-PERF-P36R — Mix & Max flavor-slot CRUD. The service layer
// (performSlotEditWithActiveGovernance, CR-005 Sub-phase 3d) already existed
// but had no HTTP route at all — this was the actual, previously-undocumented
// gap in "the builder doesn't expose a Mix & Max editor" (the P36 doc assumed
// direct API access was still possible as a workaround; it wasn't).

router.get(
  '/:productId/variants/:variantId/flavor-slots',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const slots = await productsService.listFlavorSlots(req.params.variantId as string, { id: req.user.user_id, role: req.user.role });
      res.status(200).json({ data: slots.map(toFlavorSlotResponse), error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:productId/variants/:variantId/flavor-slots',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(addFlavorSlotSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { reason, ...rest } = req.body as z.infer<typeof addFlavorSlotSchema>;
      const slot = await productsService.addFlavorSlot(
        req.params.variantId as string,
        { label: rest.label, flavorQty: rest.flavor_qty, unit: rest.unit, required: rest.required },
        reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: toFlavorSlotResponse(slot), error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:productId/variants/:variantId/flavor-slots/:slotId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(updateFlavorSlotSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { reason, ...rest } = req.body as z.infer<typeof updateFlavorSlotSchema>;
      const slot = await productsService.updateFlavorSlot(
        req.params.slotId as string,
        { label: rest.label, flavorQty: rest.flavor_qty, unit: rest.unit, required: rest.required },
        reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: toFlavorSlotResponse(slot), error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete(
  '/:productId/variants/:variantId/flavor-slots/:slotId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(z.object({ reason: z.string().max(255).optional() })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { reason } = req.body as { reason?: string };
      await productsService.removeFlavorSlot(req.params.slotId as string, reason, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(204).send();
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:productId/variants/:variantId/flavor-slots/reorder',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(reorderFlavorSlotsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { reason, slot_ids } = req.body as z.infer<typeof reorderFlavorSlotsSchema>;
      const slots = await productsService.reorderFlavorSlots(
        req.params.variantId as string,
        { slotIds: slot_ids },
        reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: slots.map(toFlavorSlotResponse), error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:productId/variants/:variantId/flavor-slots/:slotId/snack-options',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(addSnackOptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { reason, snack_product_variant_id } = req.body as z.infer<typeof addSnackOptionSchema>;
      const option = await productsService.addSnackOption(
        req.params.slotId as string,
        { snackProductVariantId: snack_product_variant_id },
        reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: { id: option.id, snack_product_variant_id: option.snackProductVariantId }, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete(
  '/:productId/variants/:variantId/flavor-slots/:slotId/snack-options/:snackOptionId',
  authenticate,
  supervisorOnly,
  requireActiveSupervisor,
  requirePasswordChange,
  validate(z.object({ reason: z.string().max(255).optional() })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { reason } = req.body as { reason?: string };
      await productsService.removeSnackOption(
        req.params.slotId as string,
        req.params.snackOptionId as string,
        reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(204).send();
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as productsRouter };
