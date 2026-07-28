import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { SHADOW_BOM_CLASSIFICATIONS } from './shadow-bom-deduction.types.js';
import { shadowBomDeductionService } from './shadow-bom-deduction.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';

const router: Router = Router();

const filterQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  branch_id: z.uuid().optional(),
  product_variant_id: z.uuid().optional(),
  classification: z.enum(SHADOW_BOM_CLASSIFICATIONS).optional(),
});

const detailsQuerySchema = filterQuerySchema.extend({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function toFilters(parsed: z.infer<typeof filterQuerySchema>) {
  return {
    since: parsed.since ? new Date(parsed.since) : undefined,
    until: parsed.until ? new Date(parsed.until) : undefined,
    branchId: parsed.branch_id,
    productVariantId: parsed.product_variant_id,
    classification: parsed.classification,
  };
}

// CR-012.1 -- read-only, admin-only shadow comparison report. Never mutates
// anything and is never read by any POS/inventory/reporting runtime path;
// exists solely so an admin can judge how close BOM deduction is to the
// legacy deduction it would replace in a future CR.

router.get('/summary', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = filterQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }

    const summary = await shadowBomDeductionService.getSummary(toFilters(parsed.data));

    res.status(200).json({
      data: {
        total_compared: summary.total,
        match_count: summary.matchCount,
        match_percentage: summary.matchPercentage,
        counts_by_classification: summary.countsByClassification,
        affected_product_variant_ids: summary.affectedProductVariantIds,
        affected_branch_ids: summary.affectedBranchIds,
      },
      error: null,
      meta: null,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/details', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = detailsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }

    const { rows, total } = await shadowBomDeductionService.getDetails(toFilters(parsed.data), parsed.data.page, parsed.data.page_size);

    res.status(200).json({
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          transaction_id: row.transactionId,
          sale_line_id: row.saleLineId,
          branch_id: row.branchId,
          product_variant_id: row.productVariantId,
          legacy_calculation: row.legacyCalculation,
          bom_calculation: row.bomCalculation,
          classification: row.classification,
          error_details: row.errorDetails,
          compared_at: row.comparedAt.toISOString(),
        })),
        page: parsed.data.page,
        page_size: parsed.data.page_size,
        total,
      },
      error: null,
      meta: null,
    });
  } catch (error) {
    next(error);
  }
});

export { router as shadowBomDeductionRouter };
