import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createProductTypeSchema, productTypeTransitionSchema, updateProductTypeSchema } from '@potato-corner/shared';
import { productTypesService } from './product-types.service.js';
import { ProductTypeError } from './product-types.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, supervisorOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { requireActiveSupervisor } from '../../middleware/require-active-employee.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const listQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ProductTypeError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// POS-PERF-P58 — same posture as the rest of the catalog: Supervisor writes,
// super_admin reads, branch/staff neither. Scope is checked per branch in the service.

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
    const result = await productTypesService.list(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(createProductTypeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const type = await productTypesService.create(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: type, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:productTypeId', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(updateProductTypeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const type = await productTypesService.update(req.params.productTypeId as string, req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: type, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

for (const [path, isActive] of [['deactivate', false], ['reactivate', true]] as const) {
  router.post(`/:productTypeId/${path}`, authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(productTypeTransitionSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const type = await productTypesService.setActive(req.params.productTypeId as string, isActive, req.body.expected_version, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(200).json({ data: type, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  });
}

export { router as productTypesRouter };
