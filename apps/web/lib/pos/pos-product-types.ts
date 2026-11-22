import { posCatalogProductTypeSchema, type PosCatalogProduct, type PosCatalogProductType } from '@potato-corner/shared';
import { z } from 'zod';

/**
 * POS-PERF-P69 — the POS Products view's product TYPE filter (Regular,
 * Promotional, Seasonal, supervisor-created types). A type is not a category
 * (Flavored Fries, Drinks) and not a size (a variant named Regular, Large).
 *
 * Filter keys are prefixed so a built-in key can never equal a custom type's
 * id, and custom types are keyed by their stable id, never their name, so a
 * rename keeps the selection and two same-named types never merge.
 */
export const ALL_PRODUCT_TYPES = 'all';

export interface PosTypeTab {
  filterKey: string;
  name: string;
}

export function posTypeFilterKey(type: PosCatalogProductType): string {
  return type.is_builtin ? `builtin:${type.key}` : `custom:${type.id ?? type.key}`;
}

/**
 * The tabs after All Types: the server's list (built-ins, then the active
 * custom types scoped to this branch), deduplicated by key. Null when the
 * catalog carries no type list (an older API, or a catalog cached before
 * P69): the filter is then hidden instead of guessing every product Regular.
 */
export function buildPosTypeTabs(types: readonly PosCatalogProductType[] | undefined): PosTypeTab[] | null {
  if (!types) return null;
  const seen = new Set<string>();
  const tabs: PosTypeTab[] = [];
  for (const type of types) {
    if (!type.is_active) continue;
    const filterKey = posTypeFilterKey(type);
    if (seen.has(filterKey)) continue;
    seen.add(filterKey);
    tabs.push({ filterKey, name: type.name });
  }
  return tabs;
}

/** A product is listed under exactly one type: its displayed one. A custom assignment never also places it under its built-in classification. */
export function productMatchesTypeFilter(product: Pick<PosCatalogProduct, 'product_type'>, filterKey: string): boolean {
  if (filterKey === ALL_PRODUCT_TYPES) return true;
  return product.product_type ? posTypeFilterKey(product.product_type) === filterKey : false;
}

/** The selection to apply now: an unknown or vanished type falls back to All Types, never to an empty list. */
export function effectiveTypeFilter(selected: string, tabs: readonly PosTypeTab[] | null): string {
  if (selected === ALL_PRODUCT_TYPES || !tabs) return ALL_PRODUCT_TYPES;
  return tabs.some((tab) => tab.filterKey === selected) ? selected : ALL_PRODUCT_TYPES;
}

const cachedTypesSchema = z.array(posCatalogProductTypeSchema);

/**
 * The type list saved beside an offline catalog (lib/offline/cache.ts writes
 * the same list on every row of one save). Undefined for rows saved before
 * P69 or a list that doesn't parse, so the filter stays hidden offline rather
 * than inventing types.
 */
export function readCachedProductTypes(rows: ReadonlyArray<{ productTypes?: unknown }>): PosCatalogProductType[] | undefined {
  const first = rows[0];
  if (!first || first.productTypes === undefined) return undefined;
  const parsed = cachedTypesSchema.safeParse(first.productTypes);
  return parsed.success ? parsed.data : undefined;
}
