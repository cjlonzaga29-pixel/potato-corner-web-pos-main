import {
  PRODUCT_CLASSIFICATIONS,
  PRODUCT_CLASSIFICATION_LABELS,
  isBuiltInProductTypeKey,
  productTypeKeySchema,
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

/** Types valid at every branch of this product, plus its current one even if inactive. */
export function productTypeOptionsFor(product: ProductResponse | ProductDetailResponse, types: ProductTypeResponse[]): ProductTypeOption[] {
  const branchIds = 'branch_availability' in product ? product.branch_availability.map((row) => row.branch_id) : (product.branches ?? []).map((row) => row.branch_id);
  const valid = types.filter((type) => type.is_active && productTypeCoversBranches(type, branchIds));
  const current = product.product_type;
  return current && !valid.some((type) => type.key === current.key) ? [...valid, current] : valid;
}
