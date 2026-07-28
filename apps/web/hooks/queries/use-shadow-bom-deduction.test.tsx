import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));

const { apiClient } = await import('@/lib/api-client');
const { useShadowBomDeductionSummary, useShadowBomDeductionDetails } = await import('./use-shadow-bom-deduction.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

const EMPTY_SUMMARY = {
  total_compared: 0,
  match_count: 0,
  match_percentage: 0,
  counts_by_classification: {},
  affected_product_variant_ids: [],
  affected_branch_ids: [],
};

const EMPTY_DETAILS = { rows: [], page: 1, page_size: 50, total: 0 };

describe('useShadowBomDeductionSummary', () => {
  it('calls GET /api/shadow-bom-deduction/summary with no query string when no filters are set', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_SUMMARY, error: null, meta: null });
    const { result } = renderHook(() => useShadowBomDeductionSummary(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/shadow-bom-deduction/summary');
  });

  it('serializes branch and classification filters into the query string', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_SUMMARY, error: null, meta: null });
    const { result } = renderHook(
      () => useShadowBomDeductionSummary({ branchId: 'branch-1', classification: 'MATCH' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/shadow-bom-deduction/summary?branch_id=branch-1&classification=MATCH');
  });

  it('returns the summary data unchanged', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_SUMMARY, error: null, meta: null });
    const { result } = renderHook(() => useShadowBomDeductionSummary(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(EMPTY_SUMMARY);
  });

  it('is disabled when enabled=false', () => {
    const { result } = renderHook(() => useShadowBomDeductionSummary({}, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiClient).not.toHaveBeenCalled();
  });

  it('surfaces the server error message on failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'FORBIDDEN', message: 'No access' }, meta: null });
    const { result } = renderHook(() => useShadowBomDeductionSummary(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('No access');
  });
});

describe('useShadowBomDeductionDetails', () => {
  it('calls GET /api/shadow-bom-deduction/details with no query string when no filters are set', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_DETAILS, error: null, meta: null });
    const { result } = renderHook(() => useShadowBomDeductionDetails(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/shadow-bom-deduction/details');
  });

  it('serializes page/pageSize alongside filters into the query string', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_DETAILS, error: null, meta: null });
    const { result } = renderHook(
      () => useShadowBomDeductionDetails({ branchId: 'branch-1', page: 2, pageSize: 10 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith('/api/shadow-bom-deduction/details?branch_id=branch-1&page=2&page_size=10');
  });

  it('returns the details page unchanged', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: EMPTY_DETAILS, error: null, meta: null });
    const { result } = renderHook(() => useShadowBomDeductionDetails(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(EMPTY_DETAILS);
  });

  it('is disabled when enabled=false', () => {
    const { result } = renderHook(() => useShadowBomDeductionDetails({}, false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiClient).not.toHaveBeenCalled();
  });
});
