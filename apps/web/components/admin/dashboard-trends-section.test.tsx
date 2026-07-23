import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DashboardTrendsSection } from './dashboard-trends-section';

const {
  mockUseDashboardSalesTrendReport,
  mockUseBranchComparisonReport,
  mockUseDashboardProductPerformanceReport,
  mockUsePaymentMethodMixReport,
  mockUseDashboardDiscountMixReport,
  mockUseReportsTrendsRealtimeSync,
} = vi.hoisted(() => ({
  mockUseDashboardSalesTrendReport: vi.fn(),
  mockUseBranchComparisonReport: vi.fn(),
  mockUseDashboardProductPerformanceReport: vi.fn(),
  mockUsePaymentMethodMixReport: vi.fn(),
  mockUseDashboardDiscountMixReport: vi.fn(),
  mockUseReportsTrendsRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardSalesTrendReport: mockUseDashboardSalesTrendReport,
  useBranchComparisonReport: mockUseBranchComparisonReport,
  useDashboardProductPerformanceReport: mockUseDashboardProductPerformanceReport,
  usePaymentMethodMixReport: mockUsePaymentMethodMixReport,
  useDashboardDiscountMixReport: mockUseDashboardDiscountMixReport,
  useReportsTrendsRealtimeSync: mockUseReportsTrendsRealtimeSync,
}));

const emptyRealtime = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
const emptyRaw = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };

beforeEach(() => {
  mockUseReportsTrendsRealtimeSync.mockReturnValue(undefined);
  mockUseDashboardSalesTrendReport.mockReturnValue(emptyRealtime);
  mockUseBranchComparisonReport.mockReturnValue(emptyRealtime);
  mockUseDashboardProductPerformanceReport.mockReturnValue(emptyRealtime);
  mockUsePaymentMethodMixReport.mockReturnValue(emptyRaw);
  mockUseDashboardDiscountMixReport.mockReturnValue(emptyRealtime);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardTrendsSection', () => {
  it('calls useReportsTrendsRealtimeSync once on mount', () => {
    render(<DashboardTrendsSection branchFilter={undefined} />);
    expect(mockUseReportsTrendsRealtimeSync).toHaveBeenCalled();
  });

  it('renders skeletons while every chart query is loading', () => {
    mockUseDashboardSalesTrendReport.mockReturnValue({ ...emptyRealtime, isLoading: true });
    mockUseBranchComparisonReport.mockReturnValue({ ...emptyRealtime, isLoading: true });
    mockUseDashboardProductPerformanceReport.mockReturnValue({ ...emptyRealtime, isLoading: true });
    mockUsePaymentMethodMixReport.mockReturnValue({ ...emptyRaw, isLoading: true });
    mockUseDashboardDiscountMixReport.mockReturnValue({ ...emptyRealtime, isLoading: true });

    const { container } = render(<DashboardTrendsSection branchFilter={undefined} />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders an error state with retry when a chart query fails', () => {
    const refetch = vi.fn();
    mockUseDashboardSalesTrendReport.mockReturnValue({ ...emptyRealtime, isError: true, refetch });

    render(<DashboardTrendsSection branchFilter={undefined} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    screen.getByText('Try again').click();
    expect(refetch).toHaveBeenCalled();
  });

  it('renders empty state for a chart with no data', () => {
    render(<DashboardTrendsSection branchFilter={undefined} />);
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
  });

  it('shows the Branch Comparison chart only when branchFilter is undefined ("All my branches")', () => {
    mockUseBranchComparisonReport.mockReturnValue({
      ...emptyRealtime,
      data: { report_type: 'BRANCH_COMPARISON', computed_at: '2026-07-23T00:00:00.000Z', branch_id: null, data: [{ branch_id: 'b1', branch_name: 'Manila', gross_sales: 100, transaction_count: 1, active_shift_count: 1, low_stock_ingredient_count: 0 }] },
    });

    const { rerender } = render(<DashboardTrendsSection branchFilter={undefined} />);
    expect(screen.getByText('Branch Comparison')).toBeInTheDocument();

    rerender(<DashboardTrendsSection branchFilter="b1" />);
    expect(screen.queryByText('Branch Comparison')).not.toBeInTheDocument();
    expect(mockUseBranchComparisonReport).toHaveBeenLastCalledWith(undefined, false);
  });

  it('renders the Sales Trend chart with data summed across branches per day', () => {
    mockUseDashboardSalesTrendReport.mockReturnValue({
      ...emptyRealtime,
      data: {
        report_type: 'DAILY_SALES',
        data: [
          { report_date: '2026-07-01', branch_id: 'b1', branch_name: 'Manila', gross_sales: 100, discount_total: 0, vat_total: 10, net_sales: 90, completed_count: 1, voided_count: 0, refunded_count: 0 },
          { report_date: '2026-07-01', branch_id: 'b2', branch_name: 'Cebu', gross_sales: 50, discount_total: 0, vat_total: 5, net_sales: 45, completed_count: 1, voided_count: 0, refunded_count: 0 },
        ],
        total: 2,
        page: 1,
        limit: 100,
      },
    });

    render(<DashboardTrendsSection branchFilter={undefined} />);

    expect(screen.getByText('Sales Trend (Last 30 Days)')).toBeInTheDocument();
  });

  it('renders Top Products and Payment Method Split chart titles', () => {
    mockUsePaymentMethodMixReport.mockReturnValue({
      ...emptyRaw,
      data: [{ payment_method: 'cash', transaction_count: 4, total_amount: 400 }],
    });

    render(<DashboardTrendsSection branchFilter={undefined} />);

    expect(screen.getByText('Top Products by Revenue')).toBeInTheDocument();
    expect(screen.getByText('Payment Method Split')).toBeInTheDocument();
    expect(screen.getByText('Discount Type Mix')).toBeInTheDocument();
  });
});
