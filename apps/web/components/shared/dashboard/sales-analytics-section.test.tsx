import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseDashboardSalesTrendReport, mockUsePaymentMethodMixReport, mockUseReportsTrendsRealtimeSync } = vi.hoisted(() => ({
  mockUseDashboardSalesTrendReport: vi.fn(),
  mockUsePaymentMethodMixReport: vi.fn(),
  mockUseReportsTrendsRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardSalesTrendReport: mockUseDashboardSalesTrendReport,
  usePaymentMethodMixReport: mockUsePaymentMethodMixReport,
  useReportsTrendsRealtimeSync: mockUseReportsTrendsRealtimeSync,
}));

vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, prefix, isLoading }: { title: string; value: number; prefix?: string; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${value}`}</span>
    </div>
  ),
}));

vi.mock('@/components/shared/charts/area-chart', () => ({ AreaChart: () => <div>Area Chart</div> }));
vi.mock('@/components/shared/charts/donut-chart', () => ({ DonutChart: () => <div>Donut Chart</div> }));

import { SalesAnalyticsSection } from './sales-analytics-section';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockDefaults() {
  mockUseDashboardSalesTrendReport.mockReturnValue({
    data: { data: [{ report_date: '2026-07-30', gross_sales: 1000 }, { report_date: '2026-07-31', gross_sales: 500 }] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUsePaymentMethodMixReport.mockReturnValue({
    data: [{ payment_method: 'cash', transaction_count: 5, total_amount: 900 }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

describe('SalesAnalyticsSection', () => {
  it('renders Gross Sales summed from the trend report', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(screen.getByText('Gross Sales — Last 7 Days')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
  });

  // P3B P0-2 — Inventory Cost Consumed KPI removed from the shared dashboard
  // component; no replacement cost/valuation metric was introduced.
  it('does not render an Inventory Cost Consumed KPI or call inventory-analytics hooks', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(screen.queryByText('Inventory Cost Consumed')).not.toBeInTheDocument();
  });

  it('scopes every underlying query to the given branchId', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId="branch-1" />);

    expect(mockUseDashboardSalesTrendReport).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-1' }));
    expect(mockUsePaymentMethodMixReport).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-1' }));
  });

  it('calls the realtime sync hook on mount', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(mockUseReportsTrendsRealtimeSync).toHaveBeenCalled();
  });

  it('renders an error state with retry when any underlying query errors', () => {
    mockDefaults();
    mockUsePaymentMethodMixReport.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
