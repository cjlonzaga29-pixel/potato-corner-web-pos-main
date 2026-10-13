import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createProductComponentSchema, updateProductComponentSchema } from '@potato-corner/shared';
import { productComponentsService } from './product-components.service.js';
import { ProductComponentError } from './product-components.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, supervisorOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { requireActiveSupervisor } from '../../middleware/require-active-employee.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const listQuerySchema = z.object({ product_variant_id: z.uuid() });

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ProductComponentError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

// R9 / POS-PERF-P34R/P35 — Supervisor owns the Recipe/BOM mapping
// capability now, ownership-scoped to a variant on a product they
// themselves created (productComponentsService); super_admin is
// read-only. Branches have no access — this mapping is not read by any
// runtime deduction path yet.

router.get('/', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const components = await productComponentsService.listByVariant(parsed.data.product_variant_id);
    res.status(200).json({ data: { components }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(createProductComponentSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const component = await productComponentsService.createMapping(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: component, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:id', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(updateProductComponentSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const component = await productComponentsService.updateMapping(
      req.params.id as string,
      req.body,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: component, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.delete('/:id', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await productComponentsService.deleteMapping(req.params.id as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(204).send();
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

export { router as productComponentsRouter };
