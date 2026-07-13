import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createFlavorSchema, updateFlavorSchema, branchFlavorAvailabilitySchema } from '@potato-corner/shared';
import { flavorsService } from './flavors.service.js';
import { FlavorError } from './flavors.types.js';
import { ProductError } from '../products/products.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const listQuerySchema = z.object({
  is_active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  search: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort_by: z.enum(['name', 'created_at', 'updated_at', 'display_order']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
});

const branchAvailabilityBodySchema = branchFlavorAvailabilitySchema.omit({ branch_id: true });

/** Routes FlavorError/ProductError to their declared status code; unexpected errors fall through to the global handler. */
function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof FlavorError || error instanceof ProductError) {
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

router.get('/', authenticate, adminOrSupervisor, async (req: Request, res: Response, next: NextFunction) => {
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
    const result = await flavorsService.getAllFlavors(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:flavorId', authenticate, adminOrSupervisor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const flavor = await flavorsService.getFlavorById(req.params.flavorId as string, req.user);
    res.status(200).json({ data: flavor, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, adminOnly, validate(createFlavorSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const flavor = await flavorsService.createFlavor(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: flavor, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:flavorId', authenticate, adminOnly, validate(updateFlavorSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const flavor = await flavorsService.updateFlavor(
      req.params.flavorId as string,
      req.body,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: flavor, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get(
  '/:flavorId/branch-availability',
  authenticate,
  adminOrSupervisor,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const matrix = await flavorsService.getFlavorBranchAvailability(req.params.flavorId as string, {
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
  '/:flavorId/branch-availability/:branchId',
  authenticate,
  adminOrSupervisor,
  branchGuard,
  validate(branchAvailabilityBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { is_available, unavailable_reason } = req.body as { is_available: boolean; unavailable_reason?: string };
      const row = await flavorsService.updateBranchFlavorAvailability(
        req.params.flavorId as string,
        req.params.branchId as string,
        is_available,
        unavailable_reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: row, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as flavorsRouter };
