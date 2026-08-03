import { Router, type NextFunction, type Request, type Response } from 'express';
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
  PRODUCT_STATUS,
  type ProductStatus,
} from '@potato-corner/shared';
import { productsService } from './products.service.js';
import { ProductError } from './products.types.js';
import { FlavorError } from '../flavors/flavors.types.js';
import { flavorsService } from '../flavors/flavors.service.js';
import { productOptionsService } from '../product-options/product-options.service.js';
import { ProductOptionError } from '../product-options/product-options.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminSupervisorOrBranch, allRoles } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requireActiveEmployee } from '../../middleware/require-active-employee.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

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

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
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

router.get('/:productId', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const product = await productsService.getProductById(req.params.productId as string, req.user);
    res.status(200).json({ data: product, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, adminOnly, requirePasswordChange, validate(createProductSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const product = await productsService.createProduct(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: product, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:productId', authenticate, adminOnly, requirePasswordChange, validate(updateProductSchema), async (req: Request, res: Response, next: NextFunction) => {
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

router.delete('/:productId', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await productsService.deleteProduct(req.params.productId as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(204).send();
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch(
  '/:productId/status',
  authenticate,
  // changeProductStatusSchema's branch_id is optional — this can be a
  // branch-scoped status flip (e.g. TEMPORARILY_UNAVAILABLE at one branch,
  // branchGuard-checked below) as well as a global lifecycle change, so
  // branch needs write access here the same as the branch-availability
  // toggles below.
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(changeProductStatusSchema),
  branchGuard,
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
  adminSupervisorOrBranch,
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
  adminSupervisorOrBranch,
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
  adminSupervisorOrBranch,
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

// Phase D1 — Admin Readiness panel & product-level publish/unpublish. Read
// access mirrors branch-availability (adminSupervisorOrBranch); publish/
// unpublish are branch-scoped writes, so they get branchGuard the same way
// the branch-availability PATCH routes above do.

router.get('/:productId/readiness', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
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
  adminSupervisorOrBranch,
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
  adminSupervisorOrBranch,
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

router.post(
  '/:productId/variants',
  authenticate,
  adminOnly,
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
  adminOnly,
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
  adminOnly,
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
  adminOnly,
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
  adminOnly,
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

// CR-008 R6 — Variant <-> Product Option Group assignment. Same posture as
// the flavor-linking routes above: Admin only (Supervisor/Branch have no
// write access to catalog identity, per R13).

router.get(
  '/:productId/variants/:variantId/option-groups',
  authenticate,
  adminSupervisorOrBranch,
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
  adminOnly,
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
  adminOnly,
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
  adminOnly,
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

export { router as productsRouter };
