import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mockOn = vi.fn();
const mockOff = vi.fn();
const mockRequestReportExport = vi.fn();
const mockTriggerBrowserDownload = vi.fn();
vi.mock('@/hooks/use-socket', () => ({ useSocket: () => ({ isConnected: true, socket: null, on: mockOn, off: mockOff, emit: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
// requestReportExport/triggerBrowserDownload back the *new* binary-safe export
// path (POST /api/reports/export now returns raw file bytes or a job
// descriptor, never something apiClient's .json()-based ExportResult shape
// can parse) — see report-export-client.ts and trigger-download.ts. Mocked
// here rather than mocking fetch, per this file's existing convention of
// mocking one layer below the hook under test.
vi.mock('@/lib/report-export-client', () => ({
  requestReportExport: mockRequestReportExport,
  ReportExportError: class ReportExportError extends Error {},
}));
vi.mock('@/lib/trigger-download', () => ({ triggerBrowserDownload: mockTriggerBrowserDownload }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { apiClient } = await import('@/lib/api-client');
const { ReportExportError } = await import('@/lib/report-export-client');
const { toast } = await import('sonner');
const {
  useDailySalesReport,
  useBranchComparisonReport,
  useRequestExport,
  useReportsRealtimeSync,
  useReportsTrendsRealtimeSync,
  useInventoryAnalyticsRealtimeSync,
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
  beforeEach(() => {
    mockRequestReportExport.mockReset();
    mockTriggerBrowserDownload.mockReset();
  });

  it('triggers a real browser download with a Blob on a successful CSV file outcome, and shows a "downloaded" toast', async () => {
    const blob = new Blob(['a,b'], { type: 'text/csv' });
    mockRequestReportExport.mockResolvedValue({ kind: 'file', file: { blob, filename: 'sales.csv', mimeType: 'text/csv', size: blob.size } });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(mockTriggerBrowserDownload).toHaveBeenCalled());
    expect(mockTriggerBrowserDownload).toHaveBeenCalledWith(expect.any(Blob), 'sales.csv');
    expect(toast.success).toHaveBeenCalledWith('CSV downloaded');
  });

  it('triggers a real browser download with a Blob on a successful PDF file outcome, and shows a "downloaded" toast', async () => {
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    mockRequestReportExport.mockResolvedValue({ kind: 'file', file: { blob, filename: 'sales.pdf', mimeType: 'application/pdf', size: blob.size } });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'pdf' });

    await waitFor(() => expect(mockTriggerBrowserDownload).toHaveBeenCalled());
    expect(mockTriggerBrowserDownload).toHaveBeenCalledWith(expect.any(Blob), 'sales.pdf');
    expect(toast.success).toHaveBeenCalledWith('PDF downloaded');
  });

  it('never downloads for a job (async/oversized-report) outcome, and shows a distinct, non-"downloaded" toast', async () => {
    mockRequestReportExport.mockResolvedValue({ kind: 'job', job_id: 'job-1', message: 'Generating your report…', estimated_seconds: 45 });
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(mockTriggerBrowserDownload).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Generating your report…');
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('downloaded'));
  });

  it('does not download and shows a CSV-specific failure toast when the client rejects (e.g. an HTML/gateway response)', async () => {
    mockRequestReportExport.mockRejectedValue(new ReportExportError('The server returned an unexpected response instead of the report file.'));
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'csv' });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mockTriggerBrowserDownload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('CSV export failed', expect.objectContaining({ description: expect.stringContaining('unexpected response') }));
  });

  it('does not download and shows the exact invalid-PDF-signature message in the PDF failure toast', async () => {
    mockRequestReportExport.mockRejectedValue(new ReportExportError('PDF export failed because the server did not return a valid PDF.'));
    const { result } = renderHook(() => useRequestExport(), { wrapper });

    result.current.mutate({ report_type: 'DAILY_SALES', filters: { page: 1, limit: 25 }, format: 'pdf' });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mockTriggerBrowserDownload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'PDF export failed',
      expect.objectContaining({ description: 'PDF export failed because the server did not return a valid PDF.' }),
    );
  });
});

describe('useReportsRealtimeSync', () => {
  it('subscribes to REPORT_EXPORT_READY and REPORT_EXPORT_FAILED on mount', () => {
    renderHook(() => useReportsRealtimeSync(), { wrapper });
    expect(mockOn).toHaveBeenCalledWith('report:export_ready', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('report:export_failed', expect.any(Function));
  });
});

describe('useReportsTrendsRealtimeSync', () => {
  it('subscribes to the sale/refund/void events that should invalidate dashboard trend charts', () => {
    renderHook(() => useReportsTrendsRealtimeSync(), { wrapper });
    expect(mockOn).toHaveBeenCalledWith('transaction:completed', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('transaction:refunded', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('void:requested', expect.any(Function));
  });
});

describe('useInventoryAnalyticsRealtimeSync', () => {
  it('subscribes to inventory movement and low/out-of-stock events', () => {
    renderHook(() => useInventoryAnalyticsRealtimeSync(), { wrapper });
    expect(mockOn).toHaveBeenCalledWith('inventory:movement_recorded', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('inventory:low_stock', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('inventory:out_of_stock', expect.any(Function));
  });
});
