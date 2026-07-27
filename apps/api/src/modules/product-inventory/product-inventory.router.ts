import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createProductInventorySchema, updateProductInventorySchema, simulateDeductionSchema } from '@potato-corner/shared';
import { productInventoryService, computeDeduction } from './product-inventory.service.js';
import { ProductInventoryError } from './product-inventory.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, adminSupervisorOrBranch, supervisorOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';
import { getAccessibleBranchIds, hasBranchAccess } from '../../lib/branch-access.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ProductInventoryError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

const listQuerySchema = z.object({
  branch_id: z.string().min(1, 'branch_id is required'),
  product_variant_id: z.uuid(),
});

// Read: admin (overview) + supervisor (full CRUD power below). Write: supervisor only.
router.get('/', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }
    const mappings = await productInventoryService.listByVariant(parsed.data.branch_id, parsed.data.product_variant_id);
    res.status(200).json({ data: { mappings }, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, supervisorOnly, requirePasswordChange, validate(createProductInventorySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchIds = await getAccessibleBranchIds(req.user);
    const mapping = await productInventoryService.createMapping(req.body, branchIds, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: mapping, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.patch('/:id', authenticate, supervisorOnly, requirePasswordChange, validate(updateProductInventorySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchIds = await getAccessibleBranchIds(req.user);
    const mapping = await productInventoryService.updateMapping(req.params.id as string, req.body, branchIds, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(200).json({ data: mapping, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.delete('/:id', authenticate, supervisorOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchIds = await getAccessibleBranchIds(req.user);
    await productInventoryService.deleteMapping(req.params.id as string, branchIds, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(204).send();
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// --- Deduction simulation (mirrors POST /api/recipes/simulate permissions) ---

router.post('/simulate', authenticate, adminSupervisorOrBranch, requirePasswordChange, validate(simulateDeductionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const body = req.body as { product_variant_id: string; flavor_id?: string | null; quantity_sold: number; branch_id?: string };
    if (body.branch_id && !(await hasBranchAccess(req.user, body.branch_id))) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    const lines = await computeDeduction({
      productVariantId: body.product_variant_id,
      flavorId: body.flavor_id ?? null,
      quantitySold: body.quantity_sold,
      branchId: body.branch_id,
    });
    res.status(200).json({
      data: {
        product_variant_id: body.product_variant_id,
        flavor_id: body.flavor_id ?? null,
        branch_id: body.branch_id ?? null,
        quantity_sold: body.quantity_sold,
        lines,
      },
      error: null,
      meta: null,
    });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

export { router as productInventoryRouter };
