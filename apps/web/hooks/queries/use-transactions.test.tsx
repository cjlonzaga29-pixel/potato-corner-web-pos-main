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

// POS-PERF-P40R — a confirmed-missing proof file is permanent; temporary failures keep retrying.
describe('proof photo queries', () => {
  function retryingWrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it('does not retry PROOF_FILE_MISSING and keeps the code on the error', async () => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'PROOF_FILE_MISSING', message: 'This photo is no longer in storage, so it cannot be shown or downloaded.' },
      meta: null,
    });
    const { usePaymentProof } = await import('./use-transactions.js');
    const { isProofFileMissing } = await import('@/lib/proof-errors');
    const { result } = renderHook(() => usePaymentProof('txn-1', true), { wrapper: retryingWrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiClient).toHaveBeenCalledTimes(1);
    expect(isProofFileMissing(result.current.error)).toBe(true);
  });

  it('retries a temporary signing failure and does not call it missing', async () => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'DISCOUNT_PROOF_URL_FAILED', message: 'Could not generate discount proof URL' },
      meta: null,
    });
    const { useDiscountProof } = await import('./use-transactions.js');
    const { isProofFileMissing } = await import('@/lib/proof-errors');
    const { result } = renderHook(() => useDiscountProof('txn-1', true), { wrapper: retryingWrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiClient).toHaveBeenCalledTimes(3);
    expect(isProofFileMissing(result.current.error)).toBe(false);
  });
});
