import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));

const { apiClient } = await import('@/lib/api-client');
const { useRecipeReadiness } = await import('./use-recipe-readiness.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

const EMPTY_REPORT = {
  generated_at: '2026-07-28T00:00:00.000Z',
  summary: { total_variants: 0, ready_count: 0, blocked_count: 0, readiness_percentage: 0, counts_by_status: {} },
  variants: [],
};

describe('useRecipeReadiness', () => {
  it('calls GET /api/recipe-readiness with no query string when no filters are set', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_REPORT, error: null, meta: null });
    const { result } = renderHook(() => useRecipeReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/recipe-readiness');
  });

  it('serializes branch_id and status filters into the query string', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_REPORT, error: null, meta: null });
    const { result } = renderHook(() => useRecipeReadiness({ branchId: 'branch-1', status: 'READY' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/recipe-readiness?branch_id=branch-1&status=READY');
  });

  it('returns the report data unchanged', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_REPORT, error: null, meta: null });
    const { result } = renderHook(() => useRecipeReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(EMPTY_REPORT);
  });

  it('is disabled when enabled=false', () => {
    const { result } = renderHook(() => useRecipeReadiness({}, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiClient).not.toHaveBeenCalled();
  });

  it('surfaces the server error message on failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'FORBIDDEN', message: 'No access' }, meta: null });
    const { result } = renderHook(() => useRecipeReadiness(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('No access');
  });
});
