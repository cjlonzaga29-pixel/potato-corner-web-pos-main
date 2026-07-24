import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createPriceOverrideSchema, reviewPriceOverrideSchema } from '@potato-corner/shared';
import { priceOverridesService } from './price-overrides.service.js';
import { PriceOverrideError } from './price-overrides.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, adminSupervisorOrBranch, branchOnly } from '../../middleware/authorize.js';
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
  if (error instanceof PriceOverrideError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  branch_id: z.uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const result = await priceOverridesService.listOverrides(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, branchOnly, requirePasswordChange, validate(createPriceOverrideSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const override = await priceOverridesService.submitOverrideRequest(req.body, req.user, req.ip ?? null);
    res.status(201).json({ data: override, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:id/review',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(reviewPriceOverrideSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const override = await priceOverridesService.reviewOverride(
        req.params.id as string,
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

export { router as priceOverridesRouter };
