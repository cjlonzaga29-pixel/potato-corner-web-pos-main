import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import * as React from 'react';

const mockUseRequestExport = { mutate: vi.fn(), isPending: false };
const mockInvalidateQueries = vi.fn();
let realtimeSyncCallback: ((payload: unknown) => void) | undefined;

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

vi.mock('@/hooks/queries/use-reports', () => {
  const empty = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  return {
    useDailySalesReport: vi.fn(() => empty),
    useCashReconciliationReport: vi.fn(() => empty),
    useVoidRefundReport: vi.fn(() => empty),
    useFraudAlertSummaryReport: vi.fn(() => empty),
    useDiscountComplianceReport: vi.fn(() => empty),
    useInventoryMovementReport: vi.fn(() => empty),
    useAttendanceSummaryReport: vi.fn(() => empty),
    useRequestExport: vi.fn(() => mockUseRequestExport),
    useReportsRealtimeSync: vi.fn((cb: (payload: unknown) => void) => {
      realtimeSyncCallback = cb;
    }),
  };
});

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpenses: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
  useExpensesRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShifts: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
  useShiftsRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-fraud-alerts', () => ({
  useFraudAlerts: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
  useFraudAlertsRealtimeSync: vi.fn(),
  useInvestigateAlert: vi.fn(() => ({ isPending: false, variables: undefined, mutateAsync: vi.fn() })),
  useDismissAlert: vi.fn(() => ({ isPending: false, variables: undefined, mutateAsync: vi.fn() })),
  useEscalateAlert: vi.fn(() => ({ isPending: false, variables: undefined, mutateAsync: vi.fn() })),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: vi.fn(() => ({ data: { branches: [{ id: 'branch-1', name: 'Main Branch' }], total: 1, page: 1, limit: 100 }, isLoading: false })),
}));

vi.mock('@/components/reports/financial-summary-panel', () => ({
  FinancialSummaryPanel: () => <div>Financial Summary Panel</div>,
}));

vi.mock('@/components/reports/inventory-analytics-panel', () => ({
  InventoryAnalyticsPanel: () => <div>Inventory Analytics Panel</div>,
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

function goToDetailedTab() {
  fireEvent.click(screen.getByRole('button', { name: /more reports/i }));
}

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
  it('renders the two top-level tabs, defaulting to Financial Summary, with legacy reports collapsed', () => {
    render(<AdminReportsPage />);
    expect(screen.getByRole('tab', { name: 'Financial Summary' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Inventory Analytics' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Detailed Reports' })).not.toBeInTheDocument();
    expect(screen.getByText('Financial Summary Panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more reports/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('tab', { name: 'Daily Sales' })).not.toBeInTheDocument();
  });

  it('expands the legacy detailed reports behind the "More Reports" disclosure', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    expect(screen.getByRole('button', { name: /hide legacy reports/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tab', { name: 'Daily Sales' })).toBeInTheDocument();
  });

  it('renders the Inventory Analytics panel when that tab is active', () => {
    render(<AdminReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Analytics' }));
    expect(screen.getByText('Inventory Analytics Panel')).toBeInTheDocument();
  });

  it('renders the 10 detailed sub-report tabs once Detailed Reports is active', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    const tabLabels = [
      'Daily Sales',
      'Cash Reconciliation',
      'Expenses',
      'Voided / Refund',
      'Shift Reports',
      'Alerts',
      'Discount Compliance',
      'Inventory Movement',
      'Attendance Summary',
      'Audit Log',
    ];
    for (const label of tabLabels) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
  });

  it('only enables the active detailed sub-tab\'s data hook', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    expect(reportsHooks.useDailySalesReport).toHaveBeenCalledWith(expect.anything(), true);
    expect(reportsHooks.useCashReconciliationReport).toHaveBeenCalledWith(expect.anything(), false);
    expect(reportsHooks.useVoidRefundReport).toHaveBeenCalledWith(expect.anything(), false);
    expect(reportsHooks.useFraudAlertSummaryReport).toHaveBeenCalledWith(expect.anything(), false);
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

  it('exports the DAILY_SALES report from the default Financial Summary tab', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('does not export when the Inventory Analytics tab is active', () => {
    render(<AdminReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Analytics' }));
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(mockUseRequestExport.mutate).not.toHaveBeenCalled();
  });

  it('exports the active detailed sub-tab\'s report type on Export PDF click', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
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

  it('renders a "select a branch" empty state on Daily Sales by default', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    expect(screen.getByText(/select a branch/i)).toBeInTheDocument();
  });

  it('renders an empty state for the active sub-tab when a branch is selected and data is empty', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(screen.getByText(/no sales in this range/i)).toBeInTheDocument();
  });

  it('renders a loading skeleton for the active sub-tab', () => {
    vi.mocked(reportsHooks.useDailySalesReport).mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() } as never);
    // ReportLastUpdated renders a plain Skeleton <div> with no accessible text while
    // isLoading — assert on its class instead of text.
    const { container } = render(<AdminReportsPage />);
    goToDetailedTab();
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders the Expenses tab empty state without requiring a branch selection', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Expenses' }));
    expect(screen.getByText('No expenses recorded')).toBeInTheDocument();
  });

  it('renders the ShiftLogPanel when the Shift Reports tab is active', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Shift Reports' }));
    expect(screen.getByText('Every Shift, Every Branch')).toBeInTheDocument();
  });

  it('renders the FraudAlertManagementPanel when the Alerts tab is active', () => {
    render(<AdminReportsPage />);
    goToDetailedTab();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Alerts' }));
    expect(screen.getByText('Alert Management')).toBeInTheDocument();
  });
});
