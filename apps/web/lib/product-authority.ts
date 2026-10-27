/**
 * POS-PERF-P36R6 — client-side mirror of catalog-authority.ts's
 * hasActiveCatalogAuthority: a supervisor may edit a product in place only
 * when their active branch assignments cover EVERY branch it is configured
 * at (or its one branch, for a branch-exclusive product). Advisory only — it
 * hides or disables actions up front; the server re-checks every write.
 * POS-PERF-P39 moved it here from the product page so the Products list and
 * the product editor apply exactly the same rule.
 */
export interface ProductAuthorityInput {
  branch_exclusive: boolean;
  exclusive_branch_id: string | null;
  /** Every branch the product is configured at, published there or not. */
  configuredBranchIds: string[];
}

export function canEditProductInPlace(product: ProductAuthorityInput, activeBranchIds: string[]): boolean {
  if (product.branch_exclusive) {
    return Boolean(product.exclusive_branch_id) && activeBranchIds.includes(product.exclusive_branch_id as string);
  }
  return product.configuredBranchIds.length === 0 || product.configuredBranchIds.every((id) => activeBranchIds.includes(id));
}
