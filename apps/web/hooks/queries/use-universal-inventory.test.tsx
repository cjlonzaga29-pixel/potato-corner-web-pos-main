import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const { useCreateInventoryItem } = await import('./use-universal-inventory.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
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
