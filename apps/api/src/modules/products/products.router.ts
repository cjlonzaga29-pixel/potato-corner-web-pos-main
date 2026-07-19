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
  PRODUCT_STATUS,
  ROLES,
  type ProductStatus,
} from '@potato-corner/shared';
import { productsService } from './products.service.js';
import { ProductError } from './products.types.js';
import { FlavorError } from '../flavors/flavors.types.js';
import { flavorsService } from '../flavors/flavors.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, allRoles } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const upload = multer({
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

/** Routes ProductError/FlavorError to their declared status code; unexpected errors fall through to the global handler. */
function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ProductError || error instanceof FlavorError) {
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
router.get('/catalog', authenticate, allRoles, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
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

router.get('/:productId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const product = await productsService.getProductById(req.params.productId as string, req.user);
    res.status(200).json({ data: product, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(createProductSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      // CR-001: Super Admin owns master catalog creation. Supervisors submit
      // a product_requests row instead — this specific error code tells the
      // client which flow to use rather than a generic 403.
      if (req.user.role !== ROLES.SUPER_ADMIN) {
        res.status(403).json({
          data: null,
          error: {
            code: 'USE_PRODUCT_REQUEST',
            message: 'Supervisors cannot create products directly — submit a product request for Super Admin approval instead.',
          },
          meta: null,
        });
        return;
      }
      const product = await productsService.createProduct(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(201).json({ data: product, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

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
  adminOrSupervisor,
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

router.post(
  '/:productId/image',
  authenticate,
  adminOnly,
  requirePasswordChange,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(
          error instanceof multer.MulterError
            ? new ProductError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422)
            : error,
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
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'An image file is required' }, meta: null });
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

router.delete('/:productId/image', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await productsService.deleteProductImage(
      req.params.productId as string,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

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
  '/:productId/branch-availability/:branchId',
  authenticate,
  adminOrSupervisor,
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

export { router as productsRouter };
