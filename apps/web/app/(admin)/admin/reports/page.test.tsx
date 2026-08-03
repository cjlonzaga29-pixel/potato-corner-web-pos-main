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
    useInventoryConsumptionSummaryReport: vi.fn(() => empty),
    useInventorySummaryReport: vi.fn(() => empty),
    useAttendanceSummaryReport: vi.fn(() => empty),
    useRequestExport: vi.fn(() => mockUseRequestExport),
    useReportsRealtimeSync: vi.fn((cb: (payload: unknown) => void) => {
      realtimeSyncCallback = cb;
    }),
    useReportsTrendsRealtimeSync: vi.fn(),
    useInventoryAnalyticsRealtimeSync: vi.fn(),
  };
});

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpenses: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
  useExpensesRealtimeSync: vi.fn(),
}));

// Backs the Daily Sales "View Transactions" drilldown (DailySalesDrilldown) — not under test
// here, just needs to not explode when the sheet mounts (closed by default in every test).
vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransaction: vi.fn(() => ({ data: undefined })),
  useTransactions: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() })),
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

// The Daily Sales drilldown sheet is closed in every test here (no row click
// triggers it) — these are mocked purely so their own hook chains (useAuth,
// usePaymentProof) don't need full stubbing just to mount inertly.
vi.mock('@/components/pos/receipt-modal', () => ({
  ReceiptModal: () => null,
}));
vi.mock('@/components/shared/transactions/view-payment-proof-dialog', () => ({
  ViewPaymentProofDialog: () => null,
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

function selectCategory(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

function selectReportTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
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
  it('renders no legacy disclosure UI or terminology anywhere', () => {
    render(<AdminReportsPage />);
    expect(screen.queryByText(/more reports/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/hide legacy reports/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/legacy/i)).not.toBeInTheDocument();
  });

  it('defaults to the Finance category with Financial Summary active', () => {
    render(<AdminReportsPage />);
    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: 'Financial Summary' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Daily Sales' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Cash Reconciliation' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Expenses' })).toBeInTheDocument();
    expect(screen.getByText('Financial Summary Panel')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Inventory Analytics' })).not.toBeInTheDocument();
  });

  it('switches the visible report tabs when a different category is selected', () => {
    render(<AdminReportsPage />);
    selectCategory('Inventory');
    expect(screen.getByRole('button', { name: 'Inventory' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: 'Inventory Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Inventory Movement' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Daily Sales' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Consumption Summary' })).not.toBeInTheDocument();
    // Selecting a category jumps to its first report.
    expect(screen.getByText('Inventory Analytics Panel')).toBeInTheDocument();
  });

  it('renders every report across all four categories', () => {
    render(<AdminReportsPage />);
    const categories: Record<string, string[]> = {
      Finance: ['Financial Summary', 'Daily Sales', 'Cash Reconciliation', 'Expenses'],
      Inventory: ['Inventory Analytics', 'Inventory Movement', 'Inventory Summary'],
      Operations: ['Shift Reports', 'Attendance Summary'],
      Compliance: ['Void / Refund', 'Alerts', 'Discount Compliance', 'Audit Log'],
    };
    for (const [category, tabs] of Object.entries(categories)) {
      selectCategory(category);
      for (const label of tabs) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('renders every ingredient in its own inventory unit with no KG conversion, no Status column, and no warning banner (TASK 144)', () => {
    vi.mocked(reportsHooks.useInventorySummaryReport).mockReturnValue({
      data: {
        generated_at: '2026-08-01T00:00:00.000Z',
        data: [
          {
            ingredient_id: 'i1',
            ingredient_name: 'Raw Fries',
            branch_id: 'branch-1',
            branch_name: 'Main Branch',
            unit: 'kg',
            opening_stock: 12.5,
            consumed_today: 2.3,
            consumed_this_month: 54.1,
            remaining_stock: 10.2,
          },
          {
            ingredient_id: 'i2',
            ingredient_name: 'Cheese Powder',
            branch_id: 'branch-1',
            branch_name: 'Main Branch',
            unit: 'tbsp',
            opening_stock: 420,
            consumed_today: 18,
            consumed_this_month: 260,
            remaining_stock: 160,
          },
          {
            ingredient_id: 'i3',
            ingredient_name: 'Vanilla Extract',
            branch_id: 'branch-1',
            branch_name: 'Main Branch',
            unit: 'tsp',
            opening_stock: 100,
            consumed_today: 5,
            consumed_this_month: 40,
            remaining_stock: 90,
          },
          {
            ingredient_id: 'i4',
            ingredient_name: 'Salt',
            branch_id: 'branch-1',
            branch_name: 'Main Branch',
            unit: 'g',
            opening_stock: 250,
            consumed_today: 35,
            consumed_this_month: 920,
            remaining_stock: 215,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    render(<AdminReportsPage />);
    selectCategory('Inventory');
    selectReportTab('Inventory Summary');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    // Every unit appears — tbsp, tsp, g, and kg — with no row excluded.
    expect(screen.getByText('Raw Fries')).toBeInTheDocument();
    expect(screen.getByText('Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('Vanilla Extract')).toBeInTheDocument();
    expect(screen.getByText('Salt')).toBeInTheDocument();

    // No leftover kg-conversion UI.
    expect(screen.queryByText(/missing unit conversions/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Converted')).not.toBeInTheDocument();
    expect(screen.queryByText('Conversion required')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByText('Packaging Consumption (PC)')).not.toBeInTheDocument();

    // Totals grouped by unit, never mixed.
    expect(screen.getByText('Total (kg)')).toBeInTheDocument();
    expect(screen.getByText('Total (tbsp)')).toBeInTheDocument();
    expect(screen.getByText('Total (tsp)')).toBeInTheDocument();
    expect(screen.getByText('Total (g)')).toBeInTheDocument();
  });

  it('renders the Total Ingredient Weight (KG) card alongside the native-unit totals, plus the missing-conversion warning when items are excluded (TASK 149)', () => {
    vi.mocked(reportsHooks.useInventorySummaryReport).mockReturnValue({
      data: {
        generated_at: '2026-08-01T00:00:00.000Z',
        data: [
          {
            ingredient_id: 'i1',
            ingredient_name: 'Raw Fries',
            branch_id: 'branch-1',
            branch_name: 'Main Branch',
            unit: 'kg',
            opening_stock: 12.5,
            consumed_today: 2.3,
            consumed_this_month: 54.1,
            remaining_stock: 10.2,
          },
        ],
        weight_summary_kg: {
          opening_stock_kg: 12.5,
          consumed_today_kg: 2.3,
          consumed_this_month_kg: 54.1,
          remaining_kg: 10.2,
          included_item_count: 1,
          excluded_item_count: 1,
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    render(<AdminReportsPage />);
    selectCategory('Inventory');
    selectReportTab('Inventory Summary');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    // Native-unit table and totals are still there, unchanged.
    expect(screen.getByText('Raw Fries')).toBeInTheDocument();
    expect(screen.getByText('Total (kg)')).toBeInTheDocument();

    // Separate KG summary card, additive to the native totals above.
    expect(screen.getByText('Total Ingredient Weight (KG)')).toBeInTheDocument();
    expect(screen.getByText('Opening Stock (KG)')).toBeInTheDocument();
    expect(screen.getByText('Consumed Today (KG)')).toBeInTheDocument();
    expect(screen.getByText('Consumed This Month (KG)')).toBeInTheDocument();
    expect(screen.getByText('Remaining (KG)')).toBeInTheDocument();
    expect(screen.getByText(/Some non-count ingredients are excluded from the KG total/i)).toBeInTheDocument();
  });

  it('omits the Total Ingredient Weight (KG) card and its warning when weight_summary_kg is absent from the response', () => {
    vi.mocked(reportsHooks.useInventorySummaryReport).mockReturnValue({
      data: {
        generated_at: '2026-08-01T00:00:00.000Z',
        data: [
          {
            ingredient_id: 'i1',
            ingredient_name: 'Raw Fries',
            branch_id: 'branch-1',
            branch_name: 'Main Branch',
            unit: 'kg',
            opening_stock: 12.5,
            consumed_today: 2.3,
            consumed_this_month: 54.1,
            remaining_stock: 10.2,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    render(<AdminReportsPage />);
    selectCategory('Inventory');
    selectReportTab('Inventory Summary');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    expect(screen.queryByText('Total Ingredient Weight (KG)')).not.toBeInTheDocument();
    expect(screen.queryByText(/excluded from the KG total/i)).not.toBeInTheDocument();
  });

  it('enables only the active tab\'s data hook', () => {
    render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
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
    selectCategory('Inventory');
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(mockUseRequestExport.mutate).not.toHaveBeenCalled();
  });

  it('exports the active tab\'s report type on Export PDF click', () => {
    render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('tracks CSV and PDF export loading state independently', () => {
    render(<AdminReportsPage />);
    const csvButton = screen.getByRole('button', { name: /export csv/i });
    const pdfButton = screen.getByRole('button', { name: /export pdf/i });
    fireEvent.click(csvButton);
    // The mutate call above resolves synchronously in this mock (no onSettled invocation captured here),
    // so assert the PDF button never reflects the CSV click's loading state.
    expect(pdfButton).not.toBeDisabled();
    fireEvent.click(pdfButton);
    expect(mockUseRequestExport.mutate).toHaveBeenCalledTimes(2);
  });

  it('renders both export buttons with type="button"', () => {
    render(<AdminReportsPage />);
    expect(screen.getByRole('button', { name: /export csv/i })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: /export pdf/i })).toHaveAttribute('type', 'button');
  });

  it('does not wrap either export button in a form that could submit/reload on click', () => {
    render(<AdminReportsPage />);
    expect(screen.getByRole('button', { name: /export csv/i }).closest('form')).toBeNull();
    expect(screen.getByRole('button', { name: /export pdf/i }).closest('form')).toBeNull();
  });

  it('clicking Export CSV never triggers the Refresh cooldown/handler', () => {
    render(<AdminReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(screen.getByRole('button', { name: /^refresh$/i })).not.toBeDisabled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('shows the idle "Export CSV" label immediately (page-level loading text lives on isExportingCsv, driven by onSettled)', async () => {
    render(<AdminReportsPage />);
    const csvButton = screen.getByRole('button', { name: /export csv/i });
    fireEvent.click(csvButton);

    // handleExport passes { onSettled } as mutate's second argument — invoking it
    // (as react-query would once the mutation resolves, success or failure) must
    // flip the button back to idle and re-enabled.
    const onSettled = mockUseRequestExport.mutate.mock.calls.at(-1)?.[1]?.onSettled;
    expect(typeof onSettled).toBe('function');
    await act(async () => {
      onSettled();
    });

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('resets to the idle, enabled state after a failed export too', async () => {
    render(<AdminReportsPage />);
    const pdfButton = screen.getByRole('button', { name: /export pdf/i });
    fireEvent.click(pdfButton);

    const onSettled = mockUseRequestExport.mutate.mock.calls.at(-1)?.[1]?.onSettled;
    await act(async () => {
      onSettled();
    });

    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  });

  it('calls useReportsRealtimeSync on mount', () => {
    render(<AdminReportsPage />);
    expect(reportsHooks.useReportsRealtimeSync).toHaveBeenCalled();
  });

  it('shows a download toast when an export-ready payload arrives for the current user', async () => {
    render(<AdminReportsPage />);
    realtimeSyncCallback?.({ requester_id: 'admin-1', report_type: 'DAILY_SALES', format: 'csv', download_url: 'https://signed.example/x.csv' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Export ready', expect.objectContaining({ description: expect.stringContaining('DAILY_SALES') })));
  });

  it('does not show a download toast for another user\'s export', () => {
    render(<AdminReportsPage />);
    realtimeSyncCallback?.({ requester_id: 'someone-else', report_type: 'DAILY_SALES', format: 'csv', download_url: 'https://signed.example/x.csv' });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders a "select a branch" empty state on Daily Sales', () => {
    render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
    expect(screen.getByText(/select a branch/i)).toBeInTheDocument();
  });

  it('disables both export buttons on a branch-required tab when no branch is selected, so clicking sends no export request', () => {
    render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
    const csvButton = screen.getByRole('button', { name: /export csv/i });
    const pdfButton = screen.getByRole('button', { name: /export pdf/i });
    expect(csvButton).toBeDisabled();
    expect(pdfButton).toBeDisabled();

    // Disabled buttons don't fire onClick in the DOM, but assert this defensively too —
    // handleExport() has its own no-branch guard in case it's ever invoked programmatically.
    fireEvent.click(csvButton);
    fireEvent.click(pdfButton);
    expect(mockUseRequestExport.mutate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('enables both export buttons on a branch-required tab once a branch is selected, and export still carries branch_id', () => {
    render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    const csvButton = screen.getByRole('button', { name: /export csv/i });
    const pdfButton = screen.getByRole('button', { name: /export pdf/i });
    expect(csvButton).toBeEnabled();
    expect(pdfButton).toBeEnabled();

    fireEvent.click(csvButton);
    expect(mockUseRequestExport.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ report_type: 'DAILY_SALES', filters: expect.objectContaining({ branch_id: 'branch-1' }) }),
      expect.anything(),
    );
  });

  it('does not disable export on the default Financial Summary tab, which supports all-branch export', () => {
    render(<AdminReportsPage />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /export pdf/i })).toBeEnabled();
  });

  it('renders an empty state for the active tab when a branch is selected and data is empty', () => {
    render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(screen.getByText(/no sales in this range/i)).toBeInTheDocument();
  });

  it('renders a loading skeleton for the active tab', () => {
    vi.mocked(reportsHooks.useDailySalesReport).mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() } as never);
    // ReportLastUpdated renders a plain Skeleton <div> with no accessible text while
    // isLoading — assert on its class instead of text.
    const { container } = render(<AdminReportsPage />);
    selectReportTab('Daily Sales');
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders the Expenses tab empty state without requiring a branch selection', () => {
    render(<AdminReportsPage />);
    selectReportTab('Expenses');
    expect(screen.getByText('No expenses recorded')).toBeInTheDocument();
  });

  it('renders the ShiftLogPanel when the Shift Reports tab is active', () => {
    render(<AdminReportsPage />);
    selectCategory('Operations');
    selectReportTab('Shift Reports');
    expect(screen.getByText('Every Shift, Every Branch')).toBeInTheDocument();
  });

  it('renders the FraudAlertManagementPanel when the Alerts tab is active', () => {
    render(<AdminReportsPage />);
    selectCategory('Compliance');
    selectReportTab('Alerts');
    expect(screen.getByText('Alert Management')).toBeInTheDocument();
  });
});
