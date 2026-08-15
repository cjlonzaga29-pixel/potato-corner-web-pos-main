import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseDashboardSalesTrendReport, mockUsePaymentMethodMixReport } = vi.hoisted(() => ({
  mockUseDashboardSalesTrendReport: vi.fn(),
  mockUsePaymentMethodMixReport: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardSalesTrendReport: mockUseDashboardSalesTrendReport,
  usePaymentMethodMixReport: mockUsePaymentMethodMixReport,
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

import { FinancialSummaryPanel } from './financial-summary-panel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockDefaults() {
  mockUseDashboardSalesTrendReport.mockReturnValue({
    data: {
      data: [
        {
          report_date: '2026-07-01',
          branch_id: 'b1',
          branch_name: 'B1',
          gross_sales: 1000,
          net_sales: 900,
          discount_total: 0,
          vat_total: 0,
          completed_count: 10,
          voided_count: 0,
          refunded_count: 0,
          cogs: 400,
          gross_profit: 500,
          waste_cost: 20,
          expense_total: 100,
          operating_result: 380,
          is_profit_estimated: false,
        },
        {
          report_date: '2026-07-02',
          branch_id: 'b1',
          branch_name: 'B1',
          gross_sales: 500,
          net_sales: 450,
          discount_total: 0,
          vat_total: 0,
          completed_count: 5,
          voided_count: 0,
          refunded_count: 0,
          cogs: 200,
          gross_profit: 250,
          waste_cost: 10,
          expense_total: 200,
          operating_result: 40,
          is_profit_estimated: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUsePaymentMethodMixReport.mockReturnValue({
    data: [{ payment_method: 'cash', transaction_count: 5, total_amount: 700 }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

describe('FinancialSummaryPanel', () => {
  it('renders the finance waterfall summed from DAILY_SALES rows — no second formula engine', () => {
    mockDefaults();
    render(<FinancialSummaryPanel branchId={null} dateFrom="2026-07-01" dateTo="2026-07-02" />);

    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('Net Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1350')).toBeInTheDocument();
    expect(screen.getByText('Cost of Goods Sold')).toBeInTheDocument();
    expect(screen.getByText('₱600')).toBeInTheDocument();
    expect(screen.getByText('Gross Profit')).toBeInTheDocument();
    expect(screen.getByText('₱750')).toBeInTheDocument();
    expect(screen.getByText('Waste Cost')).toBeInTheDocument();
    expect(screen.getByText('₱30')).toBeInTheDocument();
    expect(screen.getByText('Operating Expenses')).toBeInTheDocument();
    expect(screen.getByText('₱300')).toBeInTheDocument();
    expect(screen.getByText('Operating Result')).toBeInTheDocument();
    expect(screen.getByText('₱420')).toBeInTheDocument();
  });

  it('renders an error state with retry when any underlying query errors', () => {
    mockDefaults();
    mockUseDashboardSalesTrendReport.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<FinancialSummaryPanel branchId={null} dateFrom="2026-07-01" dateTo="2026-07-02" />);

    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
