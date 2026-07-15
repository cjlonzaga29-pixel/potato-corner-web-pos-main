import { db } from './db';

/**
 * Product catalog offline cache. Refreshed on connect and at least every
 * 30 minutes during active use, per Architecture doc §10.1. Populated from
 * the POS catalog TanStack Query cache (see hooks/queries/use-transactions.ts's
 * useCatalog) whenever it successfully refetches.
 */
export async function cacheProductCatalog(products: Array<{ id: string; data: unknown }>): Promise<void> {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  await db.cachedProducts.bulkPut(products.map((product) => ({ ...product, cachedAt: now })));
}

export async function getCachedProductCatalog() {
  if (typeof window === 'undefined') return [];
  return db.cachedProducts.toArray();
}

/**
 * Active branch price overrides, cached alongside the product catalog so
 * offline pricing matches what the terminal would resolve online (branch
 * override first, then the variant's master base_price).
 */
export async function cacheBranchPriceOverrides(overrides: Array<{ productVariantId: string; price: number }>): Promise<void> {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  await db.cachedPriceOverrides.bulkPut(
    overrides.map((o) => ({ id: o.productVariantId, price: o.price, cachedAt: now })),
  );
}

export async function getCachedPriceOverrides() {
  if (typeof window === 'undefined') return [];
  return db.cachedPriceOverrides.toArray();
}
