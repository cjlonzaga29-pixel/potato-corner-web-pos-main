import { db } from './db';

/**
 * Product catalog offline cache. Refreshed on connect and at least every
 * 30 minutes during active use, per Architecture doc §10.1.
 * TODO(Phase 10): populate from the products TanStack Query cache.
 */
export async function cacheProductCatalog(products: Array<{ id: string; data: unknown }>): Promise<void> {
  const now = Date.now();
  await db.cachedProducts.bulkPut(products.map((product) => ({ ...product, cachedAt: now })));
}

export async function getCachedProductCatalog() {
  return db.cachedProducts.toArray();
}
