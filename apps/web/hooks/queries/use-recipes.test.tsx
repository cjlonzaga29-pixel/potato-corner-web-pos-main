import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const { useRecipesList, useCreateRecipe, useDeleteRecipe } = await import('./use-recipes.js');

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

describe('useCreateRecipe', () => {
  it('shows a success toast and invalidates the recipe list on success', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: { id: 'r1', product_variant_id: 'variant-1', ingredient_id: 'i1', ingredient_name: 'Cheese', flavor_id: null, flavor_name: null, quantity: 1, unit: 'g' },
      error: null,
      meta: null,
    });
    const { result } = renderHook(() => useCreateRecipe('variant-1'), { wrapper });

    result.current.mutate({ product_variant_id: 'variant-1', ingredient_id: 'i1', quantity: 1, unit: 'g' });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(apiClient).toHaveBeenCalledWith('/api/recipes', expect.objectContaining({ method: 'POST' }));
  });

  it('shows an error toast on failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'VALIDATION_ERROR', message: 'bad input' }, meta: null });
    const { result } = renderHook(() => useCreateRecipe('variant-1'), { wrapper });

    result.current.mutate({ product_variant_id: 'variant-1', ingredient_id: 'i1', quantity: 1, unit: 'g' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('bad input'));
  });
});

describe('useDeleteRecipe', () => {
  it('surfaces the server error message as a toast (e.g. FK/state conflicts)', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'RECIPE_NOT_FOUND', message: 'Recipe not found' }, meta: null });
    const { result } = renderHook(() => useDeleteRecipe('variant-1'), { wrapper });

    result.current.mutate('r1');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Recipe not found'));
  });
});
