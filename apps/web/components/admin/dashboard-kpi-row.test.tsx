import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({
    title,
    value,
    prefix,
    isLoading,
    tone,
  }: {
    title: string;
    value: number;
    prefix?: string;
    isLoading?: boolean;
    tone?: 'default' | 'warning' | 'danger' | 'positive' | 'negative';
  }) => (
    <div data-tone={tone ?? 'default'}>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${Number.isInteger(value) ? value : value.toFixed(2)}`}</span>
    </div>
  ),
}));

import { DashboardKpiRow } from './dashboard-kpi-row';

const BASE_PROPS = {
  activeShiftsCount: 5,
  liveRevenue: 12345.5,
  pendingApprovalsCount: 0,
  flaggedShiftsCount: 0,
  transactionsCount: 10,
  activeCashiersCount: 4,
  lowStockCount: 0,
  grossSales: 20000,
  expenses: 3000,
  netProfit: 15000,
  isLoadingShifts: false,
  isLoadingRevenue: false,
  isLoadingApprovals: false,
  isLoadingFlagged: false,
  isLoadingStats: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardKpiRow', () => {
  it('renders 10 KpiCards', () => {
    render(<DashboardKpiRow {...BASE_PROPS} />);

    expect(screen.getByText('Active Shifts')).toBeInTheDocument();
    expect(screen.getByText('Live Revenue (Open Shifts)')).toBeInTheDocument();
    expect(screen.getByText('Pending Approvals')).toBeInTheDocument();
    expect(screen.getByText('Flagged Shifts')).toBeInTheDocument();
    expect(screen.getByText('Transactions Today')).toBeInTheDocument();
    expect(screen.getByText('Active Cashiers')).toBeInTheDocument();
    expect(screen.getByText('Low Stock')).toBeInTheDocument();
    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Net Profit')).toBeInTheDocument();
  });

  it('renders the Gross Sales card with correct currency formatting', () => {
    render(<DashboardKpiRow {...BASE_PROPS} grossSales={20000} />);
    expect(screen.getByText('Gross Sales').closest('div')?.textContent).toContain('₱20000');
  });

  it('renders the Expenses card with correct currency formatting', () => {
    render(<DashboardKpiRow {...BASE_PROPS} expenses={3000} />);
    expect(screen.getByText('Expenses').closest('div')?.textContent).toContain('₱3000');
  });

  it('renders the Net Profit card with positive tone when profit > 0', () => {
    const { container } = render(<DashboardKpiRow {...BASE_PROPS} netProfit={15000} />);
    const netProfitRow = screen.getByText('Net Profit').closest('div');
    expect(netProfitRow).toHaveAttribute('data-tone', 'positive');
    expect(container.querySelector('[data-tone="positive"]')).toBeInTheDocument();
  });

  it('renders the Net Profit card with negative tone when profit < 0', () => {
    render(<DashboardKpiRow {...BASE_PROPS} netProfit={-500} />);
    const netProfitRow = screen.getByText('Net Profit').closest('div');
    expect(netProfitRow).toHaveAttribute('data-tone', 'negative');
  });

  it('applies a warning treatment to low stock when count > 0', () => {
    const { container } = render(<DashboardKpiRow {...BASE_PROPS} lowStockCount={3} />);
    expect(container.querySelector('[data-tone="warning"]')).toBeInTheDocument();
  });

  it('formats revenue as PHP currency', () => {
    render(<DashboardKpiRow {...BASE_PROPS} />);
    expect(screen.getByText('₱12345.50')).toBeInTheDocument();
  });

  it('applies a warning treatment to pending approvals when count > 0', () => {
    const { container } = render(<DashboardKpiRow {...BASE_PROPS} pendingApprovalsCount={3} />);
    expect(container.querySelector('[data-tone="warning"]')).toBeInTheDocument();
  });

  it('does not apply a warning treatment to pending approvals when count is 0', () => {
    const { container } = render(<DashboardKpiRow {...BASE_PROPS} pendingApprovalsCount={0} />);
    expect(container.querySelector('[data-tone="warning"]')).not.toBeInTheDocument();
  });

  it('applies a danger treatment to flagged shifts when count > 0', () => {
    const { container } = render(<DashboardKpiRow {...BASE_PROPS} flaggedShiftsCount={2} />);
    expect(container.querySelector('[data-tone="danger"]')).toBeInTheDocument();
  });

  it('renders each KPI skeleton independently based on its own isLoading prop', () => {
    render(
      <DashboardKpiRow
        {...BASE_PROPS}
        isLoadingShifts={true}
        isLoadingRevenue={false}
        isLoadingApprovals={false}
        isLoadingFlagged={false}
      />,
    );

    const shiftsRow = screen.getByText('Active Shifts').closest('div');
    expect(shiftsRow?.textContent).toContain('loading');
    expect(screen.getByText('Live Revenue (Open Shifts)').closest('div')?.textContent).not.toContain('loading');
  });
});
