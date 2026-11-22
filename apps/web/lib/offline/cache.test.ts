import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POS-PERF-P39 — the offline catalog snapshot is per branch: a refresh
 * replaces only that branch's rows (so a product taken off POS isn't served
 * from the cache any more), another branch's snapshot is never returned, and
 * rows cached before P39 (no branch) are never served and are dropped.
 * Dexie's table is replaced by an in-memory stand-in with the same calls.
 */
type Row = { id: string; branchId?: string; data: unknown; cachedAt: number };
const rows = new Map<string, Row>();

vi.mock('./db', () => {
  const table = {
    filter: (predicate: (row: Row) => boolean) => ({
      toArray: async () => [...rows.values()].filter(predicate),
      delete: async () => {
        for (const [id, row] of rows) if (predicate(row)) rows.delete(id);
      },
    }),
    bulkPut: async (items: Row[]) => {
      for (const item of items) rows.set(item.id, item);
    },
  };
  return { db: { cachedProducts: table, transaction: async (_mode: string, _table: unknown, fn: () => Promise<void>) => fn() } };
});

const { cacheProductCatalog, getCachedProductCatalog } = await import('./cache');

describe('offline catalog cache (POS-PERF-P39)', () => {
  beforeEach(() => rows.clear());

  it("returns only the requested branch's snapshot", async () => {
    await cacheProductCatalog('branch-a', [{ id: 'p1', data: { id: 'p1', price: 59 } }]);
    await cacheProductCatalog('branch-b', [{ id: 'p1', data: { id: 'p1', price: 65 } }, { id: 'p2', data: { id: 'p2' } }]);

    expect((await getCachedProductCatalog('branch-a')).map((r) => r.data)).toEqual([{ id: 'p1', price: 59 }]);
    expect((await getCachedProductCatalog('branch-b')).map((r) => r.data)).toEqual([{ id: 'p1', price: 65 }, { id: 'p2' }]);
    expect(await getCachedProductCatalog('branch-c')).toEqual([]);
  });

  it("a refresh replaces that branch's snapshot, dropping products no longer on its catalog", async () => {
    await cacheProductCatalog('branch-a', [{ id: 'p1', data: 'p1' }, { id: 'p2', data: 'p2' }]);
    await cacheProductCatalog('branch-b', [{ id: 'p9', data: 'p9' }]);
    await cacheProductCatalog('branch-a', [{ id: 'p2', data: 'p2' }]);

    expect((await getCachedProductCatalog('branch-a')).map((r) => r.data)).toEqual(['p2']);
    expect((await getCachedProductCatalog('branch-b')).map((r) => r.data)).toEqual(['p9']);
  });

  it('never serves rows cached before P39 (no branch) and drops them on the next refresh', async () => {
    rows.set('p-legacy', { id: 'p-legacy', data: 'legacy', cachedAt: 1 });

    expect(await getCachedProductCatalog('branch-a')).toEqual([]);
    await cacheProductCatalog('branch-a', [{ id: 'p1', data: 'p1' }]);
    expect(rows.has('p-legacy')).toBe(false);
  });
});

// POS-PERF-P69 — the branch's type list is saved on each row of a save, outside `data`, and replaced with it.
describe('offline catalog cache — product types (POS-PERF-P69)', () => {
  beforeEach(() => rows.clear());

  it('saves the type list per branch beside the rows, replaces it on refresh, and keeps pre-P69 saves without one', async () => {
    const typesA = [{ key: 'regular', id: null, name: 'Regular', is_builtin: true, is_active: true }];
    await cacheProductCatalog('branch-a', [{ id: 'p1', data: { id: 'p1' } }], typesA);
    await cacheProductCatalog('branch-b', [{ id: 'p1', data: { id: 'p1' } }]);

    const a = (await getCachedProductCatalog('branch-a')) as Array<Row & { productTypes?: unknown }>;
    expect(a.map((r) => r.productTypes)).toEqual([typesA]);
    expect(a[0]?.data).toEqual({ id: 'p1' });
    const b = (await getCachedProductCatalog('branch-b')) as Array<Row & { productTypes?: unknown }>;
    expect(b[0] && 'productTypes' in b[0]).toBe(false);

    await cacheProductCatalog('branch-a', [{ id: 'p2', data: { id: 'p2' } }], []);
    const refreshed = (await getCachedProductCatalog('branch-a')) as Array<Row & { productTypes?: unknown }>;
    expect(refreshed.map((r) => [r.id, r.productTypes])).toEqual([['branch-a:p2', []]]);
  });
});
