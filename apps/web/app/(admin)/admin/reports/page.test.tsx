import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import * as React from 'react';

const mockUseRequestExport = { mutate: vi.fn(), isPending: false };
let realtimeSyncCallback: ((payload: unknown) => void) | undefined;

vi.mock('@/hooks/queries/use-reports', () => {
  const emptyRealtime = { data: undefined, isLoading: false, refetch: vi.fn() };
  const emptyPrecomputed = { data: undefined, isLoading: false, refetch: vi.fn() };
  return {
    useDailySalesReport: vi.fn(() => emptyRealtime),
    useShiftSummaryReport: vi.fn(() => emptyRealtime),
    useCashReconciliationReport: vi.fn(() => emptyRealtime),
    useVoidRefundReport: vi.fn(() => emptyRealtime),
    useDiscountComplianceReport: vi.fn(() => emptyRealtime),
    useInventoryMovementReport: vi.fn(() => emptyRealtime),
    useAttendanceSummaryReport: vi.fn(() => emptyRealtime),
    useFraudAlertSummaryReport: vi.fn(() => emptyRealtime),
    useProductPerformanceReport: vi.fn(() => emptyPrecomputed),
    useFlavorPerformanceReport: vi.fn(() => emptyPrecomputed),
    useEmployeePerformanceReport: vi.fn(() => emptyPrecomputed),
    useInventoryValuationReport: vi.fn(() => emptyPrecomputed),
    useBranchComparisonReport: vi.fn(() => emptyPrecomputed),
    useRequestExport: vi.fn(() => mockUseRequestExport),
    useReportsRealtimeSync: vi.fn((cb: (payload: unknown) => void) => {
      realtimeSyncCallback = cb;
    }),
  };
});
vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: vi.fn(() => ({ data: { branches: [{ id: 'branch-1', name: 'Main Branch' }] } })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/reports',
  useSearchParams: () => new URLSearchParams(),
}));

// Radix Select has no jsdom-friendly interaction path without user-event (not a
// project dependency); flatten it to plain buttons, matching attendance/page.test.tsx.
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});
  function Select({ onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) {
    return <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) { return <>{children}</>; }
  function SelectValue() { return null; }
  function SelectContent({ children }: { children?: React.ReactNode }) { return <>{children}</>; }
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return <button type="button" onClick={() => ctx.onValueChange?.(value)}>{children}</button>;
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});
vi.mock('@/stores/auth.store', () => ({ useAuthStore: vi.fn((selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: 'admin-1' } })) }));
vi.mock('@/stores/socket.store', () => ({ useSocketStore: vi.fn((selector: (s: { isConnected: boolean }) => unknown) => selector({ isConnected: true })) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const reportsHooks = await import('@/hooks/queries/use-reports');
const { toast } = await import('sonner');
const { default: AdminReportsPage } = await import('./page.js');

// NumberTicker (inside KpiCard) calls Framer Motion's useInView, which
// requires IntersectionObserver — not implemented in jsdom.
beforeEach(() => {
  // @ts-expect-error jsdom has no IntersectionObserver; stub it so KpiCard's NumberTicker doesn't throw on mount.
  window.IntersectionObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = () => [];
  };
  vi.clearAllMocks();
  realtimeSyncCallback = undefined;
});

afterEach(() => {
  cleanup();
});

describe('AdminReportsPage', () => {
  it('renders all 19 report tabs', () => {
    render(<AdminReportsPage />);
    const tabLabels = [
      'Daily Sales', 'Shift Summary', 'Cash Reconciliation', 'Void/Refund', 'Discount Compliance',
      'Inventory Movement', 'Attendance Summary', 'Fraud Alert Summary', 'Product Performance',
      'Flavor Performance', 'Employee Performance', 'Inventory Valuation', 'Branch Comparison',
      'Inventory Analytics', 'Shift Log', 'Product Requests Log', 'Price Overrides Log',
      'Audit Logs', 'Login Audit',
    ];
    for (const label of tabLabels) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
  });

  it('only enables the active tab\'s data hook', () => {
    render(<AdminReportsPage />);
    expect(reportsHooks.useDailySalesReport).toHaveBeenCalledWith(expect.anything(), true);
    expect(reportsHooks.useShiftSummaryReport).toHaveBeenCalledWith(expect.anything(), false);
    // useBranchComparisonReport's first arg is `selectedBranchId ?? undefined`, and the
    // page's default selection ("All Branches") is null -> undefined here. expect.anything()
    // does not match undefined, so only the `enabled` (2nd) arg is asserted.
    expect(reportsHooks.useBranchComparisonReport).toHaveBeenCalledWith(undefined, false);
  });

  it('disables the refresh button for 60 seconds after click, showing a countdown', async () => {
    vi.useFakeTimers();
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(screen.getByRole('button', { name: /refresh \(60s\)/i })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('button', { name: /refresh \(59s\)/i })).toBeDisabled();

    vi.useRealTimers();
  });

  it('calls useRequestExport.mutate with format csv on Export CSV click', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('calls useRequestExport.mutate with format pdf on Export PDF click', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('calls useReportsRealtimeSync on mount', () => {
    render(<AdminReportsPage />);
    expect(reportsHooks.useReportsRealtimeSync).toHaveBeenCalled();
  });

  it('shows a download toast when an export-ready payload arrives for the current user', async () => {
    render(<AdminReportsPage />);
    realtimeSyncCallback?.({ requester_id: 'admin-1', report_type: 'DAILY_SALES', download_url: 'https://signed.example/x.csv' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Export ready', expect.objectContaining({ description: expect.stringContaining('DAILY_SALES') })));
  });

  it('does not show a download toast for another user\'s export', () => {
    render(<AdminReportsPage />);
    realtimeSyncCallback?.({ requester_id: 'someone-else', report_type: 'DAILY_SALES', download_url: 'https://signed.example/x.csv' });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders a "select a branch" empty state by default', () => {
    render(<AdminReportsPage />);
    expect(screen.getByText(/select a branch/i)).toBeInTheDocument();
  });

  it('renders an empty state for the active tab when a branch is selected and data is empty', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(screen.getByText(/no sales in this range/i)).toBeInTheDocument();
  });

  it('renders a loading skeleton for the active tab', () => {
    vi.mocked(reportsHooks.useDailySalesReport).mockReturnValue({ data: undefined, isLoading: true, refetch: vi.fn() } as never);
    // ReportLastUpdated (Task 17) renders a plain Skeleton <div> with no accessible text
    // while isLoading — assert on its class instead of text, since there is no "not yet
    // computed"/"last updated" text present during loading.
    const { container } = render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});
