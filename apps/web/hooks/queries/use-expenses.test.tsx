import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { useExpenses, useCreateExpense, useUpdateExpense, useDeleteExpense } = await import('./use-expenses.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('useExpenses', () => {
  it('fetches the expense list from GET /api/expenses', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: { expenses: [], total: 0, total_amount: 0, page: 1, limit: 25 },
      error: null,
      meta: null,
    });

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith('/api/expenses?page=1&limit=25');
  });

  it('includes filters in both the request query string and the query key', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: { expenses: [], total: 0, total_amount: 0, page: 1, limit: 25 },
      error: null,
      meta: null,
    });

    const filters = { branch_id: 'branch-1', category: 'utilities' as const, date_from: '2026-01-01', date_to: '2026-01-31' };
    const { result } = renderHook(() => useExpenses(filters), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient).toHaveBeenCalledWith(
      '/api/expenses?branch_id=branch-1&category=utilities&date_from=2026-01-01&date_to=2026-01-31&page=1&limit=25',
    );
  });

  it('returns meta.total_amount from the response', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: { expenses: [], total: 3, total_amount: 4500.5, page: 1, limit: 25 },
      error: null,
      meta: null,
    });

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.total_amount).toBe(4500.5);
  });

  it('throws with the server error message on failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'FORBIDDEN', message: 'no access' }, meta: null });

    const { result } = renderHook(() => useExpenses(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('no access');
  });
});

describe('useCreateExpense', () => {
  it('generates and sends an Idempotency-Key header on POST /api/expenses', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: { id: 'expense-1' },
      error: null,
      meta: null,
    });

    const { result } = renderHook(() => useCreateExpense(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        branch_id: 'branch-1',
        category: 'utilities',
        amount: 100,
        incurred_at: '2026-07-01T00:00:00.000Z',
      });
    });

    expect(apiClient).toHaveBeenCalledWith(
      '/api/expenses',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Idempotency-Key': expect.any(String) },
      }),
    );
  });
});

describe('useUpdateExpense', () => {
  it('sends a PATCH to /api/expenses/:id', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { id: 'expense-1' }, error: null, meta: null });

    const { result } = renderHook(() => useUpdateExpense('expense-1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ amount: 200 });
    });

    expect(apiClient).toHaveBeenCalledWith('/api/expenses/expense-1', {
      method: 'PATCH',
      body: JSON.stringify({ amount: 200 }),
    });
  });
});

describe('useDeleteExpense', () => {
  it('sends a DELETE to /api/expenses/:id', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: null, meta: null });

    const { result } = renderHook(() => useDeleteExpense('expense-1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(apiClient).toHaveBeenCalledWith('/api/expenses/expense-1', { method: 'DELETE' });
  });
});
