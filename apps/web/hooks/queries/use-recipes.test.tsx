import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { useRecipesList } = await import('./use-recipes.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('useRecipesList', () => {
  it('is disabled when product_variant_id is falsy', () => {
    const { result } = renderHook(() => useRecipesList(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('calls GET /api/recipes with the product_variant_id query param', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { recipes: [] }, error: null, meta: null });
    const { result } = renderHook(() => useRecipesList('variant-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/recipes?product_variant_id=variant-1');
  });
});
