import { db } from './db';

/**
 * Product catalog offline cache. Refreshed on connect and at least every
 * 30 minutes during active use, per Architecture doc §10.1. Populated from
 * the POS catalog TanStack Query cache (see hooks/queries/use-products.ts's
 * useCatalog) whenever it successfully refetches.
 *
 * POS-PERF-P39 — scoped per branch. Each refresh replaces that branch's
 * whole snapshot, so a product unpublished since the last refresh is no
 * longer served from the cache, and a device signed in at another branch
 * never sees this branch's products or prices. Rows from before P39 carry
 * no branch and are dropped on the next refresh, never served.
 */
export async function cacheProductCatalog(branchId: string, products: Array<{ id: string; data: unknown }>): Promise<void> {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  await db.transaction('rw', db.cachedProducts, async () => {
    await db.cachedProducts.filter((row) => row.branchId === undefined || row.branchId === branchId).delete();
    await db.cachedProducts.bulkPut(
      products.map((product) => ({ id: `${branchId}:${product.id}`, branchId, data: product.data, cachedAt: now })),
    );
  });
}

export async function getCachedProductCatalog(branchId: string) {
  if (typeof window === 'undefined') return [];
  return db.cachedProducts.filter((row) => row.branchId === branchId).toArray();
}
