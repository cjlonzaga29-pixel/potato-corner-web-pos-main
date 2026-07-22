import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { createExpenseSchema, updateExpenseSchema, expenseListQuerySchema } from '@potato-corner/shared';
import { expensesService } from './expenses.service.js';
import { ExpenseError } from './expenses.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';
import { posthog } from '../../lib/posthog.js';

const router: Router = Router();

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new ExpenseError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ExpenseError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

router.get('/', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = expenseListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await expensesService.getExpenses(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, adminOrSupervisor, requirePasswordChange, validate(createExpenseSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const expense = await expensesService.createExpense(req.body, req.user, req.ip ?? null, idempotencyKey);
    posthog.capture({
      distinctId: req.user.user_id,
      event: 'expense_created',
      properties: {
        expense_id: expense.id,
        branch_id: expense.branch_id,
        category: expense.category,
        role: req.user.role,
      },
    });
    await posthog.flush();
    res.status(201).json({ data: expense, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:expenseId', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const expense = await expensesService.getExpenseResponse(req.params.expenseId as string, req.user);
    res.status(200).json({ data: expense, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:expenseId', authenticate, adminOrSupervisor, requirePasswordChange, validate(updateExpenseSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const expense = await expensesService.updateExpense(req.params.expenseId as string, req.body, req.user, req.ip ?? null);
    res.status(200).json({ data: expense, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.delete('/:expenseId', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await expensesService.deleteExpense(req.params.expenseId as string, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(204).send();
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:expenseId/receipt',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  (req: Request, res: Response, next: NextFunction) => {
    receiptUpload.single('receipt')(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(
          error instanceof multer.MulterError
            ? new ExpenseError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422)
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
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A receipt image file is required' }, meta: null });
        return;
      }
      const result = await expensesService.uploadReceipt(
        req.params.expenseId as string,
        { buffer: req.file.buffer, originalname: req.file.originalname },
        req.user,
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete('/:expenseId/receipt', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await expensesService.deleteReceipt(req.params.expenseId as string, req.user, req.ip ?? null);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

export { router as expensesRouter };
