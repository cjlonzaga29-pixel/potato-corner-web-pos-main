import { branchesRepository } from '../modules/branches/branches.repository.js';

/**
 * POS-PERF-P36 — replaces the POS-PERF-P35R personal-ownership model
 * (createdBy/managedBy, see catalog-ownership.ts) with branch-team
 * authority: a supervisor may manage a catalog resource whenever they
 * currently hold an *active* UserBranchAssignment to a branch that resource
 * is actually tied to, not because they personally created it or were
 * individually granted it. catalog-ownership.ts's exports stay in place
 * read-only (audit/history display of who originally created/was assigned a
 * record) but are no longer consulted for the live authority decision.
 *
 * Live supervisor-account status (deactivated/terminated) is re-validated by
 * requireActiveSupervisor middleware on this same route surface — this
 * module only ever runs after that middleware, so it does not re-check
 * isActive itself.
 */
export interface CatalogBranchScope {
  /** True for a Product created branch-exclusive (CR-001); false for every other catalog/inventory record. */
  branchExclusive: boolean;
  /** Set only when branchExclusive is true. */
  exclusiveBranchId: string | null;
  /**
   * Branches this resource is actually published/sold at right now (e.g.
   * BranchProductAvailability rows with isAvailable: true). Empty array for
   * branch-agnostic master data (categories, option groups/options, units,
   * conversions, inventory items — CR-007 §3, no branch to scope against) or
   * for a product that has never been published to any branch yet.
   */
  sellingBranchIds: string[];
}

/**
 * Branch-agnostic shared master data has no branch to intersect against —
 * "existing shared definitions remain usable without arbitrary ownership
 * claims" (POS-PERF-P36 spec): any supervisor with at least one active
 * branch assignment may manage it. A supervisor assigned to zero active
 * branches has no operational reach anywhere and gets no catalog authority.
 */
export async function hasSharedCatalogAuthority(actorId: string): Promise<boolean> {
  const activeBranchIds = await branchesRepository.findAllActiveBranchIds(actorId);
  return activeBranchIds.length > 0;
}

/**
 * POS-PERF-P36R4 — corrects the prior posture ("any active-branch
 * intersection with the product's current selling branches grants
 * authority over the *whole* product"), which let a supervisor assigned to
 * only one of a shared product's branches edit data that is global across
 * every branch selling it (Product details, ProductVariant/pricing,
 * ProductComponent recipe/BOM, ProductFlavorSlot/snack options,
 * ProductVariantOptionGroup assignments, status/archive/restore/delete,
 * image) — editing Branch A's share of a shared product silently changed
 * Branch B's too, violating "supervisor authority follows assigned
 * branches, and editing Branch A must not change Branch B."
 *
 * Branch-scoped authority for a Product (or anything resolved through one,
 * e.g. a ProductVariant's ProductComponent/ProductOption binding):
 * - branch-exclusive: the supervisor's active assignment must include
 *   exclusiveBranchId (unchanged — a single branch, so "any" and "all" are
 *   the same check).
 * - non-exclusive, configured at >=1 branch: the supervisor's active branch
 *   set must be a SUPERSET of every branch this product is configured at —
 *   i.e. full coverage, not mere overlap. A supervisor missing even one of
 *   the product's branches has no authority over this shared resource at
 *   all; see catalog-authority.ts's forkProductForBranch (products.service.ts)
 *   for the scoped path such a supervisor uses instead — a branch-exclusive
 *   copy they fully own, rather than editing the shared row in place.
 * - non-exclusive, never configured at any branch (configuredBranchIds
 *   empty): falls back to "any active supervisor" so a brand-new draft
 *   isn't orphaned before its first Add to POS — same posture as
 *   hasSharedCatalogAuthority.
 */
export async function hasActiveCatalogAuthority(actorId: string, resource: CatalogBranchScope): Promise<boolean> {
  const activeBranchIds = await branchesRepository.findAllActiveBranchIds(actorId);
  if (activeBranchIds.length === 0) return false;

  if (resource.branchExclusive) {
    return resource.exclusiveBranchId !== null && activeBranchIds.includes(resource.exclusiveBranchId);
  }

  if (resource.sellingBranchIds.length === 0) return true;

  const activeSet = new Set(activeBranchIds);
  return resource.sellingBranchIds.every((id) => activeSet.has(id));
}

/**
 * Derives CatalogBranchScope from a Product row loaded with its
 * branchAvailability relation (productsRepository.findById's detailInclude
 * shape). Deliberately includes every configured branch, not only rows
 * with isAvailable: true — a branch where the product is temporarily
 * unpublished is still a branch this shared resource is tied to, and a
 * supervisor who lost access to it must not retain authority over the rest
 * of the product just because its availability there happens to be off.
 */
export function branchScopeFromProduct(product: {
  branchExclusive: boolean;
  exclusiveBranchId: string | null;
  branchAvailability: { branchId: string }[];
}): CatalogBranchScope {
  return {
    branchExclusive: product.branchExclusive,
    exclusiveBranchId: product.exclusiveBranchId,
    sellingBranchIds: product.branchAvailability.map((a) => a.branchId),
  };
}

export async function hasActiveCatalogAuthorityForProduct(
  product: {
    branchExclusive: boolean;
    exclusiveBranchId: string | null;
    branchAvailability: { branchId: string; isAvailable: boolean }[];
  },
  actorId: string,
): Promise<boolean> {
  return hasActiveCatalogAuthority(actorId, branchScopeFromProduct(product));
}
