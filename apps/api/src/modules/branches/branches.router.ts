import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  createBranchSchema,
  updateBranchSchema,
  changeBranchStatusSchema,
  assignSupervisorSchema,
  deleteBranchSchema,
  forceDeleteBranchSchema,
  reconcileClosureItemSchema,
  type ForceDeleteBranchInput,
  BRANCH_STATUS,
  MAX_LIST_LIMIT,
  type BranchStatus,
} from '@potato-corner/shared';
import { branchesService } from './branches.service.js';
import { branchForceDeletionService } from './branch-force-deletion.service.js';
import { BranchError } from './branches.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, adminSupervisorOrBranch, allRoles } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const qrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new BranchError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

const branchStatusValues = Object.values(BRANCH_STATUS) as [BranchStatus, ...BranchStatus[]];

const listQuerySchema = z.object({
  status: z.enum(branchStatusValues).optional(),
  city: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).default(25),
});

const statsQuerySchema = z.object({
  branch_id: z.uuid().optional(),
});

/** Routes BranchError to its declared status code; unexpected errors fall through to the global handler. */
function handleBranchError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof BranchError) {
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
    const result = await branchesService.getAllBranches(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

// POS-PERF-P40 — connectivity (signed-in session presence) per branch, kept
// separate from administrative status. Must precede '/:branchId'.
router.get('/presence', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const presence = await branchesService.getBranchPresence(req.user);
    res.status(200).json({ data: presence, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

router.get('/accounts', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const accounts = await branchesService.getAllAccounts(req.user);
    res.status(200).json({ data: accounts, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

router.get('/stats', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = statsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const stats = await branchesService.getAllBranchStats(req.user, parsed.data.branch_id);
    res.status(200).json({ data: stats, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

// allRoles (not adminSupervisorOrBranch): staff-facing pages (e.g. Receipts)
// need their own branch's display info (name/address for the printed
// receipt). branchGuard + getBranchById's own assertBranchAccess both still
// restrict branch/staff to exactly their JWT branch_ids — this only adds
// STAFF to the role check, no branch-scoping is relaxed.
// POS-PERF-P68 — Force Delete Branch and the reconciliation of what it left
// unresolved. Super Admin only, here and again in the service.
const closureItemsQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  reconciled: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).default(25),
});

router.get(
  '/closure-items',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const parsed = closureItemsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(422)
          .json({
            data: null,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid query' },
            meta: null,
          });
        return;
      }
      const result = await branchForceDeletionService.listClosureItems(
        { id: req.user.user_id, role: req.user.role },
        {
          branchId: parsed.data.branch_id,
          reconciled:
            parsed.data.reconciled === undefined ? undefined : parsed.data.reconciled === 'true',
          page: parsed.data.page,
          limit: parsed.data.limit,
        },
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.post(
  '/closure-items/:itemId/reconcile',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(reconcileClosureItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await branchForceDeletionService.reconcileClosureItem(
        req.params.itemId as string,
        { id: req.user.user_id, role: req.user.role },
        (req.body as { note: string }).note,
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.get(
  '/force-deletions/:operationId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const status = await branchForceDeletionService.getStatus(
        req.params.operationId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: status, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.post(
  '/force-deletions/:operationId/abort',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const status = await branchForceDeletionService.abort(
        req.params.operationId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: status, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.get(
  '/:branchId/force-deletion-plan',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const plan = await branchForceDeletionService.getPlan(req.params.branchId as string, {
        id: req.user.user_id,
        role: req.user.role,
      });
      res.status(200).json({ data: plan, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.post(
  '/:branchId/force-delete',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(forceDeleteBranchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const status = await branchForceDeletionService.forceDelete(
        req.params.branchId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
        req.body as ForceDeleteBranchInput,
      );
      // 202 while it is still finishing (poll GET /force-deletions/:id).
      res
        .status(status.status === 'fenced' ? 202 : 200)
        .json({ data: status, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.get(
  '/:branchId',
  authenticate,
  allRoles,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branch = await branchesService.getBranchById(req.params.branchId as string, req.user);
      res.status(200).json({ data: branch, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.post('/', authenticate, adminOnly, requirePasswordChange, validate(createBranchSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branch = await branchesService.createBranch(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: branch, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

router.patch('/:branchId', authenticate, adminOnly, requirePasswordChange, validate(updateBranchSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branch = await branchesService.updateBranch(
      req.params.branchId as string,
      req.body,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: branch, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

// POS-PERF-P67 — what a permanent delete would keep, remove and require.
router.get(
  '/:branchId/deletion-eligibility',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await branchesService.getDeletionEligibility(req.params.branchId as string, {
        id: req.user.user_id,
        role: req.user.role,
      });
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

// POS-PERF-P67 — permanent delete of the operational branch; history stays
// on its branch record. The body must echo the typed name and code, the
// version and the token from deletion-eligibility. An older web sends no
// body and gets 422 (validation) without any change.
router.delete(
  '/:branchId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(deleteBranchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = await branchesService.deleteBranch(
        req.params.branchId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
        req.body,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.post(
  '/:branchId/gcash-qr',
  authenticate,
  adminOnly,
  requirePasswordChange,
  (req: Request, res: Response, next: NextFunction) => {
    qrUpload.single('qr')(req, res, (error: unknown) => {
      if (error) {
        handleBranchError(
          error instanceof multer.MulterError
            ? new BranchError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422)
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
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A QR image file is required' }, meta: null });
        return;
      }
      const result = await branchesService.uploadGcashQr(req.params.branchId as string, {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
      });
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.patch(
  '/:branchId/status',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(changeBranchStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { status } = req.body as { status: BranchStatus };
      const branch = await branchesService.changeBranchStatus(
        req.params.branchId as string,
        status,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: branch, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.get(
  '/:branchId/assignments',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const assignments = await branchesService.getAssignments(req.params.branchId as string, req.user);
      res.status(200).json({ data: assignments, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.post(
  '/:branchId/assignments',
  authenticate,
  adminOnly,
  requirePasswordChange,
  validate(assignSupervisorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { userId } = req.body as { userId: string };
      const assignment = await branchesService.assignSupervisor(
        userId,
        req.params.branchId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(201).json({ data: assignment, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.delete(
  '/:branchId/assignments/:userId',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      await branchesService.removeSupervisor(
        req.params.userId as string,
        req.params.branchId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(204).send();
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

router.get(
  '/:branchId/stats',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const stats = await branchesService.getBranchStats(req.params.branchId as string, req.user);
      res.status(200).json({ data: stats, error: null, meta: null });
    } catch (error) {
      handleBranchError(error, res, next);
    }
  },
);

export { router as branchesRouter };
