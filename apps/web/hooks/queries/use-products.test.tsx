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
