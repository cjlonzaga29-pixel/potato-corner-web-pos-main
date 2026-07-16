import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mockOn = vi.fn();
const mockOff = vi.fn();
vi.mock('@/hooks/use-socket', () => ({ useSocket: () => ({ isConnected: true, socket: null, on: mockOn, off: mockOff, emit: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { toast } = await import('sonner');
const {
  useDailySalesReport,
  useBranchComparisonReport,
  useRequestExport,
  useReportsRealtimeSync,
} = await import('./use-reports.js');

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('useDailySalesReport', () => {
  it('is disabled when branch_id is falsy (not a global report type)', () => {
    const { result } = renderHook(() => useDailySalesReport({}), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches when branch_id is provided', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { report_type: 'DAILY_SALES', data: [], total: 0, page: 1, limit: 25 }, error: null, meta: null });
    const { result } = renderHook(() => useDailySalesReport({ branch_id: 'b1' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith(expect.stringContaining('/api/reports/daily-sales?'));
  });
});

describe('useBranchComparisonReport', () => {
  it('is enabled without a branch_id, since it is a global report type', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { report_type: 'BRANCH_COMPARISON', computed_at: '2026-07-16T00:00:00.000Z', branch_id: null, data: [] }, error: null, meta: null });
    const { result } = renderHook(() => useBranchComparisonReport(undefined), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledWith(expect.stringContaining('/api/reports/branch-comparison'));
  });
});

describe('useRequestExport', () => {
  it('shows a success toast on mutation success', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: { job_id: 'job-1', message: 'queued', estimated_seconds: 10 }, error: null, meta: null });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('shows an error toast on mutation failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'EXPORT_UPLOAD_FAILED', message: 'boom' }, meta: null });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
  });
});

describe('useReportsRealtimeSync', () => {
  it('subscribes to REPORT_EXPORT_READY and REPORT_EXPORT_FAILED on mount', () => {
    renderHook(() => useReportsRealtimeSync(), { wrapper });
    expect(mockOn).toHaveBeenCalledWith('report:export_ready', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('report:export_failed', expect.any(Function));
  });
});
