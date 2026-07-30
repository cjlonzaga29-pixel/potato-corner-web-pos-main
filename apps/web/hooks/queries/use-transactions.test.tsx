import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/hooks/use-realtime-invalidate', () => ({ useRealtimeInvalidate: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { useTransactions, useDashboardRecentTransactions } = await import('./use-transactions.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useTransactions', () => {
  it('is disabled without a branch_id (staff/branch/supervisor callers always scope to one branch)', () => {
    const { result } = renderHook(() => useTransactions({}), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useDashboardRecentTransactions', () => {
  it('fetches org-wide when branch_id is omitted, unlike useTransactions', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { transactions: [], total: 0, page: 1, limit: 5 }, error: null, meta: null });
    const { result } = renderHook(() => useDashboardRecentTransactions({ limit: 5 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith(expect.stringContaining('/api/transactions?'));
  });
});
