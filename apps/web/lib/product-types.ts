import {
  PRODUCT_CLASSIFICATIONS,
  PRODUCT_CLASSIFICATION_LABELS,
  isBuiltInProductTypeKey,
  productTypeKeySchema,
  type ProductClassification,
  type ProductDetailResponse,
  type ProductResponse,
  type ProductTypeResponse,
} from '@potato-corner/shared';

export interface ProductTypeOption {
  key: string;
  name: string;
  is_active: boolean;
}

/** POS-PERF-P58 — what's offered when the type list can't load (an older API has no /api/product-types): the built-ins always exist. */
export const BUILT_IN_PRODUCT_TYPES: ProductTypeResponse[] = PRODUCT_CLASSIFICATIONS.map((key) => ({
  key,
  id: null,
  name: PRODUCT_CLASSIFICATION_LABELS[key],
  description: null,
  is_builtin: true,
  is_active: true,
  version: 0,
  branches: [],
  can_manage: false,
  product_count: null,
}));

/** A URL value that could be a type at all; whether the caller may use it is the server's answer. */
export function parseProductTypeKey(value: string | null): string | null {
  return value !== null && productTypeKeySchema.safeParse(value).success ? value : null;
}

/** A built-in applies everywhere; a custom type must cover every one of these branches. */
export function productTypeCoversBranches(type: ProductTypeResponse, branchIds: string[]): boolean {
  return type.is_builtin || branchIds.every((id) => type.branches.some((branch) => branch.branch_id === id));
}

export function productTypeLabel(product: Pick<ProductResponse, 'product_type' | 'classification'>): string {
  return product.product_type?.name ?? PRODUCT_CLASSIFICATION_LABELS[product.classification ?? 'regular'];
}

/** What a create or edit request sends. A built-in is repeated as classification, which is all an older API reads. */
export function productTypeRequestFields(key: string) {
  return isBuiltInProductTypeKey(key) ? { product_type: key, classification: key } : { product_type: key };
}

/**
 * What saving a product editor sends for its type. A built-in saves as it always
 * has, with its season window. A custom type leaves the window alone, and an
 * unchanged one isn't sent at all, so an inactive type never blocks unrelated edits.
 */
export function productTypeSaveFields(key: string, savedKey: string | undefined, seasonStart: string | undefined, seasonEnd: string | undefined) {
  if (isBuiltInProductTypeKey(key)) {
    return {
      ...productTypeRequestFields(key),
      seasonal_start_date: key === 'seasonal' && seasonStart ? seasonStart : null,
      seasonal_end_date: key === 'seasonal' && seasonEnd ? seasonEnd : null,
    };
  }
  return key === savedKey ? {} : productTypeRequestFields(key);
}

/**
 * POS-PERF-P58R — what a type change will do to promotions, before it is saved.
 * Only the classification decides promotion eligibility, and it is re-read at
 * every sale. A custom type leaves it alone, so a Promotional or Seasonal
 * product keeps a running promotion. Moving to built-in Regular is different:
 * an automatic promotion stops applying at once (resolvePromotionsForBranch).
 */
export function productTypeChangeNotice(key: string, savedKey: string, savedClassification: ProductClassification): string | null {
  if (key === savedKey) return null;
  const eligible = savedClassification !== 'regular';
  const savedLabel = PRODUCT_CLASSIFICATION_LABELS[savedClassification];
  if (!isBuiltInProductTypeKey(key)) {
    return eligible
      ? `This changes the name shown for this product only. For promotions it stays ${savedLabel}, and any running promotion keeps its discount. Changing the type doesn't stop a promotion: end it in Promotions.`
      : `This changes the name shown for this product only. For promotions it stays ${savedLabel}, so it still can't have one, whatever the type is called.`;
  }
  if (key === savedClassification) return `This product goes back to the built-in ${savedLabel} type. Promotion eligibility doesn't change.`;
  const label = PRODUCT_CLASSIFICATION_LABELS[key];
  if (key === 'regular') return `Unlike a custom type, this changes promotions. Regular products can't have an automatic promotion, so any running on this product stops applying once you save. The promotion itself stays in Promotions.`;
  return eligible
    ? `This product can still have a promotion as ${label}, and any running promotion keeps its discount.`
    : `Unlike a custom type, this changes promotions. As ${label} this product can have one, and an enabled promotion that includes it applies from the next sale.`;
}

/** Types valid at every branch of this product, plus its current one even if inactive. */
export function productTypeOptionsFor(product: ProductResponse | ProductDetailResponse, types: ProductTypeResponse[]): ProductTypeOption[] {
  const branchIds = 'branch_availability' in product ? product.branch_availability.map((row) => row.branch_id) : (product.branches ?? []).map((row) => row.branch_id);
  const valid = types.filter((type) => type.is_active && productTypeCoversBranches(type, branchIds));
  const current = product.product_type;
  return current && !valid.some((type) => type.key === current.key) ? [...valid, current] : valid;
}
