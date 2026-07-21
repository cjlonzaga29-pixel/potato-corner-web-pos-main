import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  createBranchSchema,
  updateBranchSchema,
  changeBranchStatusSchema,
  assignSupervisorSchema,
  BRANCH_STATUS,
  type BranchStatus,
} from '@potato-corner/shared';
import { branchesService } from './branches.service.js';
import { BranchError } from './branches.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
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
  limit: z.coerce.number().int().positive().max(100).default(25),
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
    const result = await branchesService.getAllBranches(req.user, parsed.data);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

router.get('/:branchId', authenticate, adminOrSupervisor, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branch = await branchesService.getBranchById(req.params.branchId as string, req.user);
    res.status(200).json({ data: branch, error: null, meta: null });
  } catch (error) {
    handleBranchError(error, res, next);
  }
});

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
  adminOrSupervisor,
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
