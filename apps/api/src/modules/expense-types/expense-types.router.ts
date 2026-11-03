import { Router, type NextFunction, type Request, type Response } from 'express';
import { createExpenseTypeSchema, expenseTypeListQuerySchema, expenseTypeTransitionSchema, updateExpenseTypeSchema } from '@potato-corner/shared';
import { expenseTypesService } from './expense-types.service.js';
import { ExpenseTypeError } from './expense-types.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminSupervisorOrBranch, supervisorOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { requireActiveSupervisor } from '../../middleware/require-active-employee.js';
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
  if (error instanceof ExpenseTypeError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// POS-PERF-P60 — Supervisor writes; everyone who can record or read expenses reads,
// since a branch account picks a type when adding one. Scope is checked per branch in the service.

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = expenseTypeListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await expenseTypesService.list(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(createExpenseTypeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const type = await expenseTypesService.create(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: type, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:expenseTypeId', authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(updateExpenseTypeSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const type = await expenseTypesService.update(req.params.expenseTypeId as string, req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: type, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

for (const [path, isActive] of [['deactivate', false], ['reactivate', true]] as const) {
  router.post(`/:expenseTypeId/${path}`, authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange, validate(expenseTypeTransitionSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const type = await expenseTypesService.setActive(req.params.expenseTypeId as string, isActive, req.body.expected_version, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(200).json({ data: type, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  });
}

export { router as expenseTypesRouter };
