import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const { useProductInventoryList, useCreateProductInventory, useUpdateProductInventory, useDeleteProductInventory } = await import(
  './use-product-inventory.js'
);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function clientWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useProductInventoryList', () => {
  it('is disabled when branchId is missing', () => {
    const { result } = renderHook(() => useProductInventoryList(undefined, 'variant-1'), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('is disabled when productVariantId is missing', () => {
    const { result } = renderHook(() => useProductInventoryList('branch-1', undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('calls GET /api/product-inventory with branch_id and product_variant_id query params', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { mappings: [] }, error: null, meta: null });
    const { result } = renderHook(() => useProductInventoryList('branch-1', 'variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/product-inventory?branch_id=branch-1&product_variant_id=variant-1');
  });

  it('returns the mappings from the response unchanged', async () => {
    const mappings = [{ id: 'm1', product_variant_id: 'variant-1', ingredient_id: 'i1' }];
    vi.mocked(apiClient).mockResolvedValue({ data: { mappings }, error: null, meta: null });
    const { result } = renderHook(() => useProductInventoryList('branch-1', 'variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mappings);
  });

  it('surfaces the server error message on failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'NOT_FOUND', message: 'Mappings not found' }, meta: null });
    const { result } = renderHook(() => useProductInventoryList('branch-1', 'variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Mappings not found');
  });

  it('does not reuse cached data across different branch IDs', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function sharedWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    vi.mocked(apiClient).mockResolvedValueOnce({ data: { mappings: [{ id: 'branch-a-mapping' }] }, error: null, meta: null });
    const { result: resultA } = renderHook(() => useProductInventoryList('branch-a', 'variant-1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(resultA.current.isSuccess).toBe(true));

    vi.mocked(apiClient).mockResolvedValueOnce({ data: { mappings: [{ id: 'branch-b-mapping' }] }, error: null, meta: null });
    const { result: resultB } = renderHook(() => useProductInventoryList('branch-b', 'variant-1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(resultB.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith('/api/product-inventory?branch_id=branch-a&product_variant_id=variant-1');
    expect(apiClient).toHaveBeenCalledWith('/api/product-inventory?branch_id=branch-b&product_variant_id=variant-1');
    expect(resultA.current.data).toEqual([{ id: 'branch-a-mapping' }]);
    expect(resultB.current.data).toEqual([{ id: 'branch-b-mapping' }]);
  });
});

const CREATE_INPUT = {
  branch_id: 'branch-1',
  product_variant_id: 'variant-1',
  ingredient_id: 'ingredient-1',
  quantity_required: 2,
  unit: 'g',
};

describe('useCreateProductInventory', () => {
  it('invalidates the branch-scoped product-inventory list query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'm1' }, error: null, meta: null });

    const { result } = renderHook(() => useCreateProductInventory('variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync(CREATE_INPUT);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-inventory', 'branch-1', 'variant-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['product-inventory', 'variant-1'] });
  });

  it('invalidates a different key for a different branch_id', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'm1' }, error: null, meta: null });

    const { result } = renderHook(() => useCreateProductInventory('variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ ...CREATE_INPUT, branch_id: 'branch-2' });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-inventory', 'branch-2', 'variant-1'] });
  });

  it('sends the create payload unchanged to POST /api/product-inventory', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'm1' }, error: null, meta: null });
    const { result } = renderHook(() => useCreateProductInventory('variant-1'), { wrapper });
    await result.current.mutateAsync(CREATE_INPUT);

    expect(apiClient).toHaveBeenCalledWith('/api/product-inventory', { method: 'POST', body: JSON.stringify(CREATE_INPUT) });
  });

  it('shows a success toast and surfaces the error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({ data: { id: 'm1' }, error: null, meta: null });
    const { result } = renderHook(() => useCreateProductInventory('variant-1'), { wrapper });
    await result.current.mutateAsync(CREATE_INPUT);
    expect(toast.success).toHaveBeenCalledWith('Inventory item added');

    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'BAD_REQUEST', message: 'Invalid input' }, meta: null });
    await expect(result.current.mutateAsync(CREATE_INPUT)).rejects.toThrow('Invalid input');
    expect(toast.error).toHaveBeenCalledWith('Invalid input');
  });
});

const UPDATE_INPUT = { quantity_required: 5, unit: 'ml' };

describe('useUpdateProductInventory', () => {
  it('invalidates the branch-scoped product-inventory list query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'm1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateProductInventory('branch-1', 'variant-1', 'mapping-1'), {
      wrapper: clientWrapper(queryClient),
    });
    await result.current.mutateAsync(UPDATE_INPUT);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-inventory', 'branch-1', 'variant-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['product-inventory', 'variant-1'] });
  });

  it('invalidates a different key for a different branchId argument', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'm1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateProductInventory('branch-2', 'variant-1', 'mapping-1'), {
      wrapper: clientWrapper(queryClient),
    });
    await result.current.mutateAsync(UPDATE_INPUT);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-inventory', 'branch-2', 'variant-1'] });
  });

  it('sends the update payload unchanged to PATCH /api/product-inventory/:mappingId', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'm1' }, error: null, meta: null });
    const { result } = renderHook(() => useUpdateProductInventory('branch-1', 'variant-1', 'mapping-1'), { wrapper });
    await result.current.mutateAsync(UPDATE_INPUT);

    expect(apiClient).toHaveBeenCalledWith('/api/product-inventory/mapping-1', { method: 'PATCH', body: JSON.stringify(UPDATE_INPUT) });
  });

  it('shows a success toast and surfaces the error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({ data: { id: 'm1' }, error: null, meta: null });
    const { result } = renderHook(() => useUpdateProductInventory('branch-1', 'variant-1', 'mapping-1'), { wrapper });
    await result.current.mutateAsync(UPDATE_INPUT);
    expect(toast.success).toHaveBeenCalledWith('Inventory item updated');

    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'NOT_FOUND', message: 'Mapping not found' }, meta: null });
    await expect(result.current.mutateAsync(UPDATE_INPUT)).rejects.toThrow('Mapping not found');
    expect(toast.error).toHaveBeenCalledWith('Mapping not found');
  });
});

describe('useDeleteProductInventory', () => {
  it('invalidates the branch-scoped product-inventory list query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });

    const { result } = renderHook(() => useDeleteProductInventory('branch-1', 'variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('mapping-1');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-inventory', 'branch-1', 'variant-1'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['product-inventory', 'variant-1'] });
  });

  it('invalidates a different key for a different branchId argument', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });

    const { result } = renderHook(() => useDeleteProductInventory('branch-2', 'variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('mapping-1');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-inventory', 'branch-2', 'variant-1'] });
  });

  it('sends DELETE /api/product-inventory/:mappingId unchanged', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });
    const { result } = renderHook(() => useDeleteProductInventory('branch-1', 'variant-1'), { wrapper });
    await result.current.mutateAsync('mapping-1');

    expect(apiClient).toHaveBeenCalledWith('/api/product-inventory/mapping-1', { method: 'DELETE' });
  });

  it('shows a success toast and surfaces the error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: null, meta: null });
    const { result } = renderHook(() => useDeleteProductInventory('branch-1', 'variant-1'), { wrapper });
    await result.current.mutateAsync('mapping-1');
    expect(toast.success).toHaveBeenCalledWith('Inventory item removed');

    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'NOT_FOUND', message: 'Mapping not found' }, meta: null });
    await expect(result.current.mutateAsync('mapping-1')).rejects.toThrow('Mapping not found');
    expect(toast.error).toHaveBeenCalledWith('Mapping not found');
  });
});
