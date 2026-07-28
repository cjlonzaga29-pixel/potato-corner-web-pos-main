/**
 * CR-011.2 — Recipe/BOM Readiness Validation.
 *
 * Read-only checks that determine which active/sellable ProductVariants are
 * safe to switch onto ProductComponent-based POS deduction in a future CR
 * (CR-012). Nothing in this module writes to the database or is read by any
 * POS/inventory/reporting runtime path — it is purely a diagnostic report.
 */

export const READINESS_STATUSES = [
  'READY',
  'NO_RECIPE',
  'INVALID_COMPONENT',
  'UNRESOLVED_MAPPING',
  'INCOMPLETE_BRANCH_STOCK',
  'BACKFILL_CONFLICT',
  'LEGACY_FLAVOR_DEPENDENCY',
  'INACTIVE',
] as const;

export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export interface ReadinessBlocker {
  code: ReadinessStatus;
  message: string;
  inventoryItemIds?: string[];
  branchIds?: string[];
}

export interface VariantReadiness {
  productId: string;
  productName: string;
  productVariantId: string;
  variantName: string;
  sizeLabel: string;
  status: ReadinessStatus;
  blockers: ReadinessBlocker[];
  affectedBranchIds: string[];
  affectedInventoryItemIds: string[];
  /** Active branches where the product is currently available (branch-exclusive/BranchProductAvailability aware); empty for INACTIVE variants. */
  availableBranchIds: string[];
}

export interface ReadinessSummary {
  totalVariants: number;
  readyCount: number;
  blockedCount: number;
  readinessPercentage: number;
  countsByStatus: Record<ReadinessStatus, number>;
}

export interface ReadinessReport {
  generatedAt: Date;
  summary: ReadinessSummary;
  variants: VariantReadiness[];
}

export interface ReadinessFilters {
  productId?: string;
  productVariantId?: string;
  branchId?: string;
  status?: ReadinessStatus;
  /** Org-wide active branch ids the requesting actor is permitted to see — undefined means unrestricted (super_admin). */
  accessibleBranchIds?: string[] | 'all';
}
