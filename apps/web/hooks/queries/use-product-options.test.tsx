import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const { useDeleteProductOptionGroup } = await import('./use-product-options.js');

function clientWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

beforeEach(() => vi.clearAllMocks());

describe('useDeleteProductOptionGroup', () => {
  it('calls DELETE /api/product-options/:groupId exactly once, invalidates the list, drops the detail cache entry, and toasts success', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });

    const { result } = renderHook(() => useDeleteProductOptionGroup(), { wrapper: clientWrapper(queryClient) });
    await result.current.mutateAsync('group-1');

    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(apiClient).toHaveBeenCalledWith('/api/product-options/group-1', { method: 'DELETE' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['product-option-groups'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['product-option-group', 'group-1'] });
    expect(toast.success).toHaveBeenCalledWith('Product option group deleted permanently.');
  });

  it('surfaces the API error message via toast and does not invalidate on failure (e.g. 409 in-use)', async () => {
    const queryClient = newClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'OPTION_GROUP_IN_USE', message: 'Remove this option group from 2 product variants before deleting it permanently' },
      meta: null,
    });

    const { result } = renderHook(() => useDeleteProductOptionGroup(), { wrapper: clientWrapper(queryClient) });
    await expect(result.current.mutateAsync('group-1')).rejects.toThrow(
      'Remove this option group from 2 product variants before deleting it permanently',
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Remove this option group from 2 product variants before deleting it permanently'));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
