import { Router, type NextFunction, type Request, type Response } from 'express';
import { SubmitInventoryRequestSchema, ApproveInventoryRequestSchema, RejectInventoryRequestSchema } from '@potato-corner/shared';
import { inventoryRequestsService } from './inventory-requests.service.js';
import { InventoryRequestError } from './inventory-requests.types.js';
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
  if (error instanceof InventoryRequestError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

router.post(
  '/',
  authenticate,
  // CR-003: submission is a branch-operational action, matching the
  // submit endpoints in price-overrides/product-requests/flavor-requests
  // routers — was adminOrSupervisor, branch now submits instead.
  branchOnly,
  requirePasswordChange,
  validate(SubmitInventoryRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const request = await inventoryRequestsService.submitRequest(req.body, req.user, req.ip ?? null);
      res.status(201).json({ data: request, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get('/pending', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await inventoryRequestsService.listPending(req.user);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:id/approve',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(ApproveInventoryRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const request = await inventoryRequestsService.approveRequest(req.params.id as string, req.user, req.ip ?? null);
      res.status(200).json({ data: request, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:id/reject',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(RejectInventoryRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const request = await inventoryRequestsService.rejectRequest(req.params.id as string, req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: request, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as inventoryRequestsRouter };
