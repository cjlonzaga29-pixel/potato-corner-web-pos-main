import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const {
  useCreateInventoryItem,
  useInventoryItemConversions,
  useCreateInventoryItemConversion,
  useUpdateInventoryItemConversion,
  useDeleteInventoryItemConversion,
} = await import('./use-universal-inventory.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Wrapper that exposes its QueryClient so invalidation scope can be asserted directly. */
function makeWrapperWithClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function ClientWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, ClientWrapper };
}

beforeEach(() => vi.clearAllMocks());

describe('useCreateInventoryItem', () => {
  it('creates an item with blank sku/barcode/category sent as undefined', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'item-1' }, error: null, meta: null });
    const { result } = renderHook(() => useCreateInventoryItem(), { wrapper });

    result.current.mutate({ name: 'Frozen Fries', sku: undefined, barcode: undefined, category_id: undefined, base_unit_id: 'unit-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith(
      '/api/universal-inventory/items',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Frozen Fries', base_unit_id: 'unit-1' }) }),
    );
    expect(toast.success).toHaveBeenCalledWith('Inventory item created');
  });

  it('surfaces a duplicate-SKU 409 message from the backend instead of a generic toast', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'SKU_CONFLICT', message: 'SKU "RAW-001" is already in use' },
      meta: null,
    });
    const { result } = renderHook(() => useCreateInventoryItem(), { wrapper });

    result.current.mutate({ name: 'Frozen Fries', sku: 'RAW-001', base_unit_id: 'unit-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toast.error).toHaveBeenCalledWith('SKU "RAW-001" is already in use');
  });

  it('surfaces a validation field error rather than a generic message', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'VALIDATION_ERROR', message: 'base_unit_id: Invalid UUID' },
      meta: null,
    });
    const { result } = renderHook(() => useCreateInventoryItem(), { wrapper });

    result.current.mutate({ name: 'Frozen Fries', base_unit_id: 'not-a-uuid' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toast.error).toHaveBeenCalledWith('base_unit_id: Invalid UUID');
  });
});

describe('useInventoryItemConversions', () => {
  it('lists conversions scoped to the item', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { conversions: [{ id: 'conv-1' }] }, error: null, meta: null });
    const { result } = renderHook(() => useInventoryItemConversions('item-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith('/api/universal-inventory/items/item-1/conversions');
    expect(result.current.data).toEqual([{ id: 'conv-1' }]);
  });
});

describe('item-conversion mutations — TASK 121 (scoped invalidation)', () => {
  it('useCreateInventoryItemConversion invalidates only this item\'s conversion query key', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'conv-1' }, error: null, meta: null });
    const { queryClient, ClientWrapper } = makeWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateInventoryItemConversion('item-1'), { wrapper: ClientWrapper });

    result.current.mutate({ from_unit_id: 'unit-tbsp', to_unit_id: 'unit-g', factor: 7 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith(
      '/api/universal-inventory/items/item-1/conversions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ from_unit_id: 'unit-tbsp', to_unit_id: 'unit-g', factor: 7 }) }),
    );
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory-item-conversions', 'item-1'] });
  });

  it('useUpdateInventoryItemConversion sends only the factor and invalidates the item-scoped key', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'conv-1', factor: 9 }, error: null, meta: null });
    const { queryClient, ClientWrapper } = makeWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateInventoryItemConversion('item-1', 'conv-1'), { wrapper: ClientWrapper });

    result.current.mutate({ factor: 9 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith(
      '/api/universal-inventory/items/item-1/conversions/conv-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ factor: 9 }) }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory-item-conversions', 'item-1'] });
  });

  it('useDeleteInventoryItemConversion calls DELETE and invalidates the item-scoped key', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'conv-1' }, error: null, meta: null });
    const { queryClient, ClientWrapper } = makeWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteInventoryItemConversion('item-1', 'conv-1'), { wrapper: ClientWrapper });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith('/api/universal-inventory/items/item-1/conversions/conv-1', expect.objectContaining({ method: 'DELETE' }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inventory-item-conversions', 'item-1'] });
  });
});
