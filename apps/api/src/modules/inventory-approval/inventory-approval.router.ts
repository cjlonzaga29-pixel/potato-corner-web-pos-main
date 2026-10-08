import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { correctInventoryApprovalRequestSchema, returnInventoryApprovalRequestSchema } from '@potato-corner/shared';
import { inventoryApprovalService } from './inventory-approval.service.js';
import { InventoryApprovalError } from './inventory-approval.types.js';
import { UniversalInventoryError } from '../universal-inventory/universal-inventory.types.js';
import { IngredientError } from '../inventory/inventory.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, adminSupervisorOrBranch } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new InventoryApprovalError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

function handleUpload(uploader: (req: Request, res: Response, callback: (error?: unknown) => void) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    uploader(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(error instanceof multer.MulterError ? new InventoryApprovalError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422) : error, res, next);
        return;
      }
      next();
    });
  };
}

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

/** Routes this module's and the two underlying inventory modules' domain errors to their declared status codes — approve()/returnForCorrection() can surface UniversalInventoryError/IngredientError from inside the apply step. */
function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof InventoryApprovalError || error instanceof UniversalInventoryError || error instanceof IngredientError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: (error as InventoryApprovalError).details }, meta: null });
    return;
  }
  next(error);
}

const listQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'RETURNED']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

const router: Router = Router();

router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, meta: null });
      return;
    }
    const result = await inventoryApprovalService.listRequests(req.user, {
      branchId: parsed.data.branch_id,
      status: parsed.data.status,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:id', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await inventoryApprovalService.getRequestDetail(req.params.id as string, req.user);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/:id/approve', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await inventoryApprovalService.approve(req.params.id as string, req.user, req.ip ?? null);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:id/return',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(returnInventoryApprovalRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof returnInventoryApprovalRequestSchema>;
      const result = await inventoryApprovalService.returnForCorrection(req.params.id as string, body.reason, req.user);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:id/correct',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(correctInventoryApprovalRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as z.infer<typeof correctInventoryApprovalRequestSchema>;
      const result = await inventoryApprovalService.correct(
        req.params.id as string,
        {
          enteredQuantity: body.entered_quantity,
          enteredUnitId: body.entered_unit_id,
          totalCost: body.total_cost,
          deliveryReference: body.delivery_reference,
          quantityDelta: body.quantity_delta,
          countedQuantity: body.counted_quantity,
          reasonCode: body.reason_code,
          notes: body.notes,
        },
        req.user,
      );
      res.status(201).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:id/proof',
  authenticate,
  adminSupervisorOrBranch,
  requirePasswordChange,
  handleUpload(proofUpload.single('proof')),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A proof image file is required' }, meta: null });
        return;
      }
      const result = await inventoryApprovalService.attachProof(req.params.id as string, { buffer: req.file.buffer, originalname: req.file.originalname }, req.user);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as inventoryApprovalRouter };
