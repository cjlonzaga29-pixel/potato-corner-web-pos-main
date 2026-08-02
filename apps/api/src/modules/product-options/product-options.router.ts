import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createProductOptionGroupSchema,
  updateProductOptionGroupSchema,
  createProductOptionSchema,
  updateProductOptionSchema,
} from '@potato-corner/shared';
import { productOptionsService } from './product-options.service.js';
import { ProductOptionError } from './product-options.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
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
  sort_by: z.enum(['name', 'code', 'sort_order', 'created_at']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ProductOptionError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// R5/R13 — same posture as product-categories: Super Admin owns option
// group/option identity (write); Supervisor is read-only; Branch has no
// access.

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
    const result = await productOptionsService.getAllGroups(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:groupId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const group = await productOptionsService.getGroupById(req.params.groupId as string);
    res.status(200).json({ data: group, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, adminOnly, requirePasswordChange, validate(createProductOptionGroupSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const group = await productOptionsService.createGroup(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: group, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:groupId', authenticate, adminOnly, requirePasswordChange, validate(updateProductOptionGroupSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const group = await productOptionsService.updateGroup(
      req.params.groupId as string,
      req.body,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: group, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:groupId/options',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(createProductOptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const option = await productOptionsService.createOption(
        req.params.groupId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: option, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.patch(
  '/:groupId/options/:optionId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(updateProductOptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const option = await productOptionsService.updateOption(
        req.params.groupId as string,
        req.params.optionId as string,
        req.body,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: option, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get(
  '/:groupId/options/:optionId/variants',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const variants = await productOptionsService.getAssignedVariantsForOption(req.params.groupId as string, req.params.optionId as string);
      res.status(200).json({ data: { variants }, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as productOptionsRouter };
