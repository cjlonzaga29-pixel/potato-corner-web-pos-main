import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const { useProductComponents, useCreateProductComponent, useUpdateProductComponent, useDeleteProductComponent } = await import(
  './use-product-components.js'
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

describe('useProductComponents', () => {
  it('is disabled when productVariantId is missing', () => {
    const { result } = renderHook(() => useProductComponents(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('calls GET /api/product-components with product_variant_id', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { components: [] }, error: null, meta: null });
    const { result } = renderHook(() => useProductComponents('variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/product-components?product_variant_id=variant-1');
  });

  it('returns the components from the response unchanged', async () => {
    const components = [{ id: 'c1', product_variant_id: 'variant-1', inventory_item_id: 'i1' }];
    vi.mocked(apiClient).mockResolvedValue({ data: { components }, error: null, meta: null });
    const { result } = renderHook(() => useProductComponents('variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(components);
  });

  it('surfaces the server error message on failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'NOT_FOUND', message: 'Variant not found' }, meta: null });
    const { result } = renderHook(() => useProductComponents('variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Variant not found');
  });
});

const CREATE_INPUT = {
  product_variant_id: 'variant-1',
  inventory_item_id: 'item-1',
  quantity_required: 2,
};

describe('useCreateProductComponent', () => {
  it('invalidates the variant-scoped component list query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'c1' }, error: null, meta: null });

    const { result } = renderHook(() => useCreateProductComponent('variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync(CREATE_INPUT);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-components', 'variant-1'] });
  });

  it('sends the create payload unchanged to POST /api/product-components', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'c1' }, error: null, meta: null });
    const { result } = renderHook(() => useCreateProductComponent('variant-1'), { wrapper });
    await result.current.mutateAsync(CREATE_INPUT);

    expect(apiClient).toHaveBeenCalledWith('/api/product-components', { method: 'POST', body: JSON.stringify(CREATE_INPUT) });
  });

  it('shows a success toast and surfaces the error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({ data: { id: 'c1' }, error: null, meta: null });
    const { result } = renderHook(() => useCreateProductComponent('variant-1'), { wrapper });
    await result.current.mutateAsync(CREATE_INPUT);
    expect(toast.success).toHaveBeenCalledWith('Recipe component added');

    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'MAPPING_ALREADY_EXISTS', message: 'Already mapped' }, meta: null });
    await expect(result.current.mutateAsync(CREATE_INPUT)).rejects.toThrow('Already mapped');
    expect(toast.error).toHaveBeenCalledWith('Already mapped');
  });
});

describe('useUpdateProductComponent', () => {
  it('invalidates the variant-scoped component list query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'c1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateProductComponent('variant-1', 'c1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync({ quantity_required: 5 });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-components', 'variant-1'] });
  });

  it('sends PATCH /api/product-components/:id with the update payload unchanged', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'c1' }, error: null, meta: null });
    const { result } = renderHook(() => useUpdateProductComponent('variant-1', 'c1'), { wrapper });
    await result.current.mutateAsync({ quantity_required: 5 });

    expect(apiClient).toHaveBeenCalledWith('/api/product-components/c1', { method: 'PATCH', body: JSON.stringify({ quantity_required: 5 }) });
  });

  it('shows a success toast and surfaces the error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({ data: { id: 'c1' }, error: null, meta: null });
    const { result } = renderHook(() => useUpdateProductComponent('variant-1', 'c1'), { wrapper });
    await result.current.mutateAsync({ quantity_required: 5 });
    expect(toast.success).toHaveBeenCalledWith('Recipe component updated');

    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'NOT_FOUND', message: 'Component not found' }, meta: null });
    await expect(result.current.mutateAsync({ quantity_required: 5 })).rejects.toThrow('Component not found');
    expect(toast.error).toHaveBeenCalledWith('Component not found');
  });
});

describe('useDeleteProductComponent', () => {
  it('invalidates the variant-scoped component list query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });

    const { result } = renderHook(() => useDeleteProductComponent('variant-1'), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('c1');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-components', 'variant-1'] });
  });

  it('sends DELETE /api/product-components/:id unchanged', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });
    const { result } = renderHook(() => useDeleteProductComponent('variant-1'), { wrapper });
    await result.current.mutateAsync('c1');

    expect(apiClient).toHaveBeenCalledWith('/api/product-components/c1', { method: 'DELETE' });
  });

  it('shows a success toast and surfaces the error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: null, meta: null });
    const { result } = renderHook(() => useDeleteProductComponent('variant-1'), { wrapper });
    await result.current.mutateAsync('c1');
    expect(toast.success).toHaveBeenCalledWith('Recipe component removed');

    vi.mocked(apiClient).mockResolvedValueOnce({ data: null, error: { code: 'NOT_FOUND', message: 'Component not found' }, meta: null });
    await expect(result.current.mutateAsync('c1')).rejects.toThrow('Component not found');
    expect(toast.error).toHaveBeenCalledWith('Component not found');
  });
});
