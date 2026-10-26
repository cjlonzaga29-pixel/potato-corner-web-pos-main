import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const {
  useChangeProductStatus,
  useUpdateBranchProductAvailability,
  useBulkUpdateBranchProductAvailability,
  useCreateVariant,
  useUpdateVariant,
  useDeleteVariant,
  useLinkVariantFlavor,
  useUpdateVariantFlavor,
  useProductReadiness,
  usePublishProduct,
  usePublishProductToBranches,
  usePublicationCheck,
  ProductApiError,
  PublicationNotConfirmedError,
  useConfirmPublication,
  useUnpublishProduct,
} = await import('./use-products.js');

function clientWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

beforeEach(() => vi.clearAllMocks());

describe('useChangeProductStatus', () => {
  it('invalidates all catalog entries (not branch-scoped) since product status is global', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'product-1' }, error: null, meta: null });

    const { result } = renderHook(() => useChangeProductStatus('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ status: 'inactive' } as never);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });
});

describe('useUpdateBranchProductAvailability', () => {
  it('invalidates the catalog entry for the exact mutated branchId', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'row-1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateBranchProductAvailability('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ branchId: 'branch-1', isAvailable: false });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-2'] });
  });
});

describe('useBulkUpdateBranchProductAvailability', () => {
  it('invalidates the catalog entry for every branch_id in the bulk update', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { updated: 2 }, error: null, meta: null });

    const { result } = renderHook(() => useBulkUpdateBranchProductAvailability('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync([
      { branch_id: 'branch-1', is_available: true },
      { branch_id: 'branch-2', is_available: false },
    ]);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-2'] });
  });
});

describe('useCreateVariant / useUpdateVariant / useDeleteVariant', () => {
  it('useCreateVariant invalidates all catalog entries (variant changes are not branch-scoped)', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'variant-1' }, error: null, meta: null });

    const { result } = renderHook(() => useCreateVariant('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ name: 'Regular' } as never);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });

  it('useUpdateVariant invalidates all catalog entries', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'variant-1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateVariant('product-1', 'variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ basePrice: 100 } as never);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });

  it('useDeleteVariant invalidates all catalog entries', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });

    const { result } = renderHook(() => useDeleteVariant('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('variant-1');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });
});

describe('useProductReadiness (Phase D1)', () => {
  it('requests the given branchId and only enables once both productId and branchId are present', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient).mockResolvedValue({ data: { scope: 'branch', product_id: 'product-1' }, error: null, meta: null });

    const { result } = renderHook(() => useProductReadiness('product-1', 'branch-1'), { wrapper: clientWrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/products/product-1/readiness?branch_id=branch-1');
  });

  it('does not fire until a branchId is selected', () => {
    const queryClient = newClient();
    renderHook(() => useProductReadiness('product-1', null), { wrapper: clientWrapper(queryClient) });

    expect(apiClient).not.toHaveBeenCalled();
  });
});

describe('usePublishProduct / useUnpublishProduct (Phase D1) — scoped invalidation only', () => {
  it('usePublishProduct invalidates product detail, readiness (every branch view), branch-availability, and only the affected branch catalog', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { branch_id: 'branch-1', is_available: true }, error: null, meta: null });

    const { result } = renderHook(() => usePublishProduct('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('branch-1');

    expect(apiClient).toHaveBeenCalledWith(
      '/api/products/product-1/publish',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ branch_id: 'branch-1' }) }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product', 'product-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product', 'product-1', 'readiness'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product', 'product-1', 'branch-availability'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-1'] });
    // Scoped, not a global reset — the bare 'catalog' key (every branch) must never be invalidated by a single-branch publish.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });

  it('useUnpublishProduct invalidates the same scoped set for the affected branch', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { branch_id: 'branch-1', is_available: false }, error: null, meta: null });

    const { result } = renderHook(() => useUnpublishProduct('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('branch-1');

    expect(apiClient).toHaveBeenCalledWith(
      '/api/products/product-1/unpublish',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ branch_id: 'branch-1' }) }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });
});

describe('useLinkVariantFlavor / useUpdateVariantFlavor', () => {
  it('useLinkVariantFlavor invalidates all catalog entries', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'link-1' }, error: null, meta: null });

    const { result } = renderHook(() => useLinkVariantFlavor('product-1', 'variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ flavorId: 'flavor-1' } as never);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });

  it('useUpdateVariantFlavor invalidates all catalog entries', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'link-1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateVariantFlavor('product-1', 'variant-1', 'flavor-1'), {
      wrapper: clientWrapper(queryClient),
    });
    await result.current.mutateAsync({ isAvailable: false } as never);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog'] });
  });
});

describe('POS-PERF-P37 — multi-branch Add to POS', () => {
  it('posts the whole branch selection once and invalidates every selected branch catalog, no others', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { product_id: 'product-1', branches: [] }, error: null, meta: null });

    const { result } = renderHook(() => usePublishProductToBranches('product-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync(['branch-a', 'branch-b']);

    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(apiClient).toHaveBeenCalledWith('/api/products/product-1/publish-branches', {
      method: 'POST',
      body: JSON.stringify({ branch_ids: ['branch-a', 'branch-b'] }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-a'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-b'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-c'] });
  });

  it('surfaces the server error and refetches readiness when publication is rejected', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'PRODUCT_NOT_READY', message: 'Product is not ready to publish at Branch B. Nothing was published.' },
      meta: null,
    });

    const { result } = renderHook(() => usePublishProductToBranches('product-1'), { wrapper: clientWrapper(queryClient) });
    await expect(result.current.mutateAsync(['branch-a', 'branch-b'])).rejects.toThrow(/Branch B/);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product', 'product-1', 'readiness'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product', 'product-1', 'publication-check'] });
  });

  it('POS-PERF-P38: keeps the maintenance code on the thrown error so Review can show it inline', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'SERVICE_WRITE_GATE_CLOSED', message: 'Temporarily unavailable for maintenance. Please try again shortly.' },
      meta: null,
    });

    const { result } = renderHook(() => usePublishProductToBranches('product-1'), { wrapper: clientWrapper(queryClient) });
    const error = await result.current.mutateAsync(['branch-a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProductApiError);
    expect(error).toMatchObject({ code: 'SERVICE_WRITE_GATE_CLOSED' });
  });

  it('POS-PERF-P38: loads one publication check for the whole selection, order-independent', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient).mockResolvedValue({ data: { product_id: 'product-1', ready: true, issues: [], branches: [] }, error: null, meta: null });

    const { result } = renderHook(() => usePublicationCheck('product-1', ['branch-b', 'branch-a']), { wrapper: clientWrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(apiClient).toHaveBeenCalledWith(`/api/products/product-1/publication-check?branch_ids=${encodeURIComponent('branch-a,branch-b')}`);
    expect(queryClient.getQueryData(['product', 'product-1', 'publication-check', 'branch-a,branch-b'])).toBeTruthy();
  });
});

describe('POS-PERF-P38R3 — a publish whose answer was lost is reconciled, never repeated', () => {
  const networkError = { data: null, error: { code: 'NETWORK_ERROR', message: 'Could not reach the server.' }, meta: null };
  const plan = (published: Record<string, boolean>) => ({
    data: {
      product_id: 'product-1',
      ready: true,
      issues: [],
      branches: Object.entries(published).map(([branch_id, is_published]) => ({ branch_id, branch_name: branch_id, is_published, status: is_published ? 'on_pos' : 'ready', issues: [], notices: [], setup_items: [] })),
    },
    error: null,
    meta: null,
  });
  // The reconciliation read carries a unique `fresh=` so the service worker's cached fallback can never answer it.
  const calls = () =>
    vi.mocked(apiClient).mock.calls.map(([path, init]) => {
      const fresh = /&fresh=\d+$/.test(path);
      return `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path.replace(/&fresh=\d+$/, '')}${fresh ? ' (fresh)' : ''}`;
    });

  it('Add to POS: a lost answer to a publication that committed resolves as published, with one POST and a read-only check', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient).mockResolvedValueOnce(networkError).mockResolvedValueOnce(plan({ 'branch-a': true, 'branch-b': true }));

    const { result } = renderHook(() => usePublishProductToBranches('product-1'), { wrapper: clientWrapper(queryClient) });
    await expect(result.current.mutateAsync(['branch-a', 'branch-b'])).resolves.toBe('published');

    expect(calls()).toEqual([
      'POST /api/products/product-1/publish-branches',
      `GET /api/products/product-1/publication-check?branch_ids=${encodeURIComponent('branch-a,branch-b')} (fresh)`,
    ]);
  });

  it('Add to POS: not on POS at every branch → not_published, never retried automatically', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient).mockResolvedValueOnce(networkError).mockResolvedValueOnce(plan({ 'branch-a': true, 'branch-b': false }));

    const { result } = renderHook(() => usePublishProductToBranches('product-1'), { wrapper: clientWrapper(queryClient) });
    const error = await result.current.mutateAsync(['branch-a', 'branch-b']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PublicationNotConfirmedError);
    expect(error).toMatchObject({ outcome: 'not_published', code: 'NETWORK_ERROR' });
    expect(calls().filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('Publish: an unreadable or failed answer plus a failed check → unknown', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient)
      .mockResolvedValueOnce({ data: null, error: { code: 'UNREADABLE_RESPONSE', message: 'Checkout could not be confirmed.' }, meta: null })
      .mockResolvedValueOnce(networkError);

    const { result } = renderHook(() => usePublishProduct('product-1'), { wrapper: clientWrapper(queryClient) });
    const error = await result.current.mutateAsync('branch-a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PublicationNotConfirmedError);
    expect(error).toMatchObject({ outcome: 'unknown' });
    expect(calls()).toEqual(['POST /api/products/product-1/publish', 'GET /api/products/product-1/publication-check?branch_ids=branch-a (fresh)']);
  });

  it('a definite rejection is shown as it is, without a check', async () => {
    const queryClient = newClient();
    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'BRANCH_ACCESS_DENIED', message: 'No access.' }, meta: null });

    const { result } = renderHook(() => usePublishProduct('product-1'), { wrapper: clientWrapper(queryClient) });
    const error = await result.current.mutateAsync('branch-a').catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(PublicationNotConfirmedError);
    expect(error).toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });
    expect(apiClient).toHaveBeenCalledTimes(1);
  });

  it('Check again only reads, and refreshes the product and its branches', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValueOnce(plan({ 'branch-a': true }));

    const { result } = renderHook(() => useConfirmPublication('product-1'), { wrapper: clientWrapper(queryClient) });
    await expect(result.current(['branch-a'])).resolves.toBe('published');

    expect(calls()).toEqual(['GET /api/products/product-1/publication-check?branch_ids=branch-a (fresh)']);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product', 'product-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['catalog', 'branch-a'] });
  });
});
