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
