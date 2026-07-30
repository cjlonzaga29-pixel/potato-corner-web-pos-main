import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const {
  mockUseDashboardSalesTrendReport,
  mockUsePaymentMethodMixReport,
  mockUseInventoryAnalytics,
  mockUseReportsTrendsRealtimeSync,
  mockUseInventoryAnalyticsRealtimeSync,
} = vi.hoisted(() => ({
  mockUseDashboardSalesTrendReport: vi.fn(),
  mockUsePaymentMethodMixReport: vi.fn(),
  mockUseInventoryAnalytics: vi.fn(),
  mockUseReportsTrendsRealtimeSync: vi.fn(),
  mockUseInventoryAnalyticsRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardSalesTrendReport: mockUseDashboardSalesTrendReport,
  usePaymentMethodMixReport: mockUsePaymentMethodMixReport,
  useInventoryAnalytics: mockUseInventoryAnalytics,
  useReportsTrendsRealtimeSync: mockUseReportsTrendsRealtimeSync,
  useInventoryAnalyticsRealtimeSync: mockUseInventoryAnalyticsRealtimeSync,
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
  mockUseInventoryAnalytics.mockReturnValue({
    data: { summary: { total_consumption_cost: 400, total_waste_cost: 0, avg_turnover_rate: 0, total_movements: 0 } },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

describe('SalesAnalyticsSection', () => {
  it('renders Gross Sales summed from the trend report and Inventory Cost Consumed from the same-period inventory analytics summary', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('Inventory Cost Consumed')).toBeInTheDocument();
    expect(screen.getByText('₱400')).toBeInTheDocument();
  });

  it('scopes every underlying query to the given branchId', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId="branch-1" />);

    expect(mockUseDashboardSalesTrendReport).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-1' }));
    expect(mockUsePaymentMethodMixReport).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-1' }));
    expect(mockUseInventoryAnalytics).toHaveBeenCalledWith('branch-1', '7d');
  });

  it('calls both realtime sync hooks on mount', () => {
    mockDefaults();
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(mockUseReportsTrendsRealtimeSync).toHaveBeenCalled();
    expect(mockUseInventoryAnalyticsRealtimeSync).toHaveBeenCalled();
  });

  it('renders an error state with retry when any underlying query errors', () => {
    mockDefaults();
    mockUseInventoryAnalytics.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<SalesAnalyticsSection branchId={undefined} />);

    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
