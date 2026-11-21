import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  ROLES,
  createExtraSupplyIssueSchema,
  createExtraSupplySchema,
  extraSupplyConversionPreviewSchema,
  extraSupplyImageUploadSchema,
  extraSupplyIssueExportQuerySchema,
  extraSupplyIssueListQuerySchema,
  extraSupplyIssueSummaryQuerySchema,
  extraSupplyListQuerySchema,
  extraSupplyTerminalQuerySchema,
  extraSupplyTransitionSchema,
  updateExtraSupplySchema,
} from '@potato-corner/shared';
import { extraSuppliesService } from './extra-supplies.service.js';
import { ExtraSupplyError } from './extra-supplies.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminSupervisorOrBranch, allRoles, authorize, supervisorOnly } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requireActiveEmployee, requireActiveSupervisor } from '../../middleware/require-active-employee.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { shiftGuard } from '../../middleware/shift-guard.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

// Same limits as product images: 5MB, JPEG/PNG/WebP.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new ExtraSupplyError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

/** The terminal's own identities. A supervisor or admin doesn't run a register, so has no cashier attribution to give. */
const cashierRoles = authorize(ROLES.BRANCH, ROLES.STAFF);

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ExtraSupplyError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function parseQuery<S extends z.ZodType>(schema: S, req: Request, res: Response): z.output<S> | null {
  const parsed = schema.safeParse(req.query);
  if (parsed.success) return parsed.data;
  res.status(422).json({
    data: null,
    error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    meta: null,
  });
  return null;
}

function uuidParam(req: Request, res: Response, name: string, code: string): string | null {
  const value = req.params[name] as string;
  if (z.uuid().safeParse(value).success) return value;
  res.status(404).json({ data: null, error: { code, message: 'Not found' }, meta: null });
  return null;
}

/** Same reasoning as the expense routes: reads for everyone in scope, card writes for supervisors. */
const supervisorWrite: RequestHandler[] = [authenticate, supervisorOnly, requireActiveSupervisor, requirePasswordChange];

// Registered before /:extraSupplyId.

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = parseQuery(extraSupplyListQuerySchema, req, res);
    if (!query) return;
    res.status(200).json({ data: await extraSuppliesService.list(req.user, query), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/conversion-preview', ...supervisorWrite, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = parseQuery(extraSupplyConversionPreviewSchema, req, res);
    if (!query) return;
    res.status(200).json({ data: await extraSuppliesService.previewConversion(query.inventory_item_id, query.entered_quantity, query.entered_unit_id), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/terminal', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = parseQuery(extraSupplyTerminalQuerySchema, req, res);
    if (!query) return;
    res.status(200).json({ data: await extraSuppliesService.terminalCards(req.user, query.branch_id), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// authenticate -> authorize -> branchGuard -> shiftGuard -> validate, the checkout chain:
// clock-in, break and shift are enforced here on every request, whatever the terminal shows.
router.post('/issues', authenticate, cashierRoles, requireActiveEmployee, requirePasswordChange, branchGuard, shiftGuard, validate(createExtraSupplyIssueSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const body = req.body as z.output<typeof createExtraSupplyIssueSchema>;
    const branchId = req.user.role === ROLES.STAFF ? req.user.branch_ids[0] : body.branch_id;
    if (!branchId) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_NOT_ASSIGNED' }, meta: null });
      return;
    }
    const issue = await extraSuppliesService.createIssue(body, branchId, req.activeShift?.id, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(issue.replayed ? 200 : 201).json({ data: issue, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/issues', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = parseQuery(extraSupplyIssueListQuerySchema, req, res);
    if (!query) return;
    res.status(200).json({ data: await extraSuppliesService.listIssues(req.user, query), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/issues/summary', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = parseQuery(extraSupplyIssueSummaryQuerySchema, req, res);
    if (!query) return;
    res.status(200).json({ data: await extraSuppliesService.getSummary(req.user, query), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/issues/export', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const query = parseQuery(extraSupplyIssueExportQuerySchema, req, res);
    if (!query) return;
    const { buffer, filename } = await extraSuppliesService.exportCsv(req.user, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buffer);
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/issues/:issueId', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const issueId = uuidParam(req, res, 'issueId', 'EXTRA_SUPPLY_ISSUE_NOT_FOUND');
    if (!issueId) return;
    res.status(200).json({ data: await extraSuppliesService.getIssue(req.user, issueId), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// Deliberately no shiftGuard on recovery: a cashier now on break or clocked out must
// still be able to learn what happened to their own submission.
router.get('/operations/:operationId', authenticate, cashierRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const operationId = uuidParam(req, res, 'operationId', 'EXTRA_SUPPLY_OPERATION_NOT_FOUND');
    if (!operationId) return;
    res.status(200).json({ data: await extraSuppliesService.getOperation(operationId, { id: req.user.user_id, role: req.user.role }), error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

const abandonOperationSchema = z.object({ branch_id: z.uuid() });

router.post('/operations/:operationId/abandon', authenticate, cashierRoles, requireActiveEmployee, requirePasswordChange, branchGuard, validate(abandonOperationSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const operationId = uuidParam(req, res, 'operationId', 'EXTRA_SUPPLY_OPERATION_NOT_FOUND');
    if (!operationId) return;
    const result = await extraSuppliesService.abandonOperation(operationId, (req.body as { branch_id: string }).branch_id, { id: req.user.user_id, role: req.user.role });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', ...supervisorWrite, validate(createExtraSupplySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const supply = await extraSuppliesService.create(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: supply, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:extraSupplyId', ...supervisorWrite, validate(updateExtraSupplySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const extraSupplyId = uuidParam(req, res, 'extraSupplyId', 'EXTRA_SUPPLY_NOT_FOUND');
    if (!extraSupplyId) return;
    const supply = await extraSuppliesService.update(extraSupplyId, req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: supply, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

for (const [path, isActive] of [['deactivate', false], ['reactivate', true]] as const) {
  router.post(`/:extraSupplyId/${path}`, ...supervisorWrite, validate(extraSupplyTransitionSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const extraSupplyId = uuidParam(req, res, 'extraSupplyId', 'EXTRA_SUPPLY_NOT_FOUND');
      if (!extraSupplyId) return;
      const supply = await extraSuppliesService.setActive(extraSupplyId, isActive, req.body.expected_version, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(200).json({ data: supply, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  });
}

router.post(
  '/:extraSupplyId/image',
  ...supervisorWrite,
  (req: Request, res: Response, next: NextFunction) => {
    imageUpload.single('image')(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(error instanceof multer.MulterError ? new ExtraSupplyError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422) : error, res, next);
        return;
      }
      next();
    });
  },
  validate(extraSupplyImageUploadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const extraSupplyId = uuidParam(req, res, 'extraSupplyId', 'EXTRA_SUPPLY_NOT_FOUND');
      if (!extraSupplyId) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'An image file is required' }, meta: null });
        return;
      }
      const supply = await extraSuppliesService.uploadImage(extraSupplyId, { buffer: req.file.buffer }, req.body.expected_version, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(200).json({ data: supply, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.delete('/:extraSupplyId/image', ...supervisorWrite, validate(extraSupplyTransitionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const extraSupplyId = uuidParam(req, res, 'extraSupplyId', 'EXTRA_SUPPLY_NOT_FOUND');
    if (!extraSupplyId) return;
    const supply = await extraSuppliesService.removeImage(extraSupplyId, req.body.expected_version, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: supply, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

export { router as extraSuppliesRouter };
