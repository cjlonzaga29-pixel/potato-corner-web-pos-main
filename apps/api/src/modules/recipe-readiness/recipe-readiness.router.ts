import { Router, type NextFunction, type Request, type Response } from 'express';
import { recipeReadinessQuerySchema } from '@potato-corner/shared';
import { recipeReadinessService } from './recipe-readiness.service.js';
import type { ReadinessBlocker, ReadinessReport, VariantReadiness } from './recipe-readiness.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { getAccessibleBranchIds } from '../../lib/branch-access.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function toBlockerResponse(blocker: ReadinessBlocker) {
  return {
    code: blocker.code,
    message: blocker.message,
    inventory_item_ids: blocker.inventoryItemIds ?? [],
    branch_ids: blocker.branchIds ?? [],
  };
}

function toVariantResponse(variant: VariantReadiness) {
  return {
    product_id: variant.productId,
    product_name: variant.productName,
    product_variant_id: variant.productVariantId,
    variant_name: variant.variantName,
    size_label: variant.sizeLabel,
    status: variant.status,
    blockers: variant.blockers.map(toBlockerResponse),
    affected_branch_ids: variant.affectedBranchIds,
    affected_inventory_item_ids: variant.affectedInventoryItemIds,
    available_branch_ids: variant.availableBranchIds,
  };
}

function toReportResponse(report: ReadinessReport) {
  return {
    generated_at: report.generatedAt.toISOString(),
    summary: {
      total_variants: report.summary.totalVariants,
      ready_count: report.summary.readyCount,
      blocked_count: report.summary.blockedCount,
      readiness_percentage: report.summary.readinessPercentage,
      counts_by_status: report.summary.countsByStatus,
    },
    variants: report.variants.map(toVariantResponse),
  };
}

// R9 posture (same as universal-inventory / product-components): Admin owns
// write paths elsewhere in the Recipe/BOM domain; this endpoint is read-only
// for both Admin and Supervisor. Supervisor is branch-assignment-scoped per
// branch-access.ts — branch_id here filters the report, it never widens
// what a role can already see.
router.get('/', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = recipeReadinessQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR' }, meta: null });
      return;
    }

    const accessibleBranchIds = await getAccessibleBranchIds(req.user);
    if (parsed.data.branch_id && accessibleBranchIds !== 'all' && !accessibleBranchIds.includes(parsed.data.branch_id)) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }

    const report = await recipeReadinessService.buildReport({
      productId: parsed.data.product_id,
      productVariantId: parsed.data.product_variant_id,
      branchId: parsed.data.branch_id,
      status: parsed.data.status,
      accessibleBranchIds,
    });

    res.status(200).json({ data: toReportResponse(report), error: null, meta: null });
  } catch (error) {
    next(error);
  }
});

export { router as recipeReadinessRouter };
