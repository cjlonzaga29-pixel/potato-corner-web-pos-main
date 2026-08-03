import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, prefix, isLoading }: { title: string; value: number; prefix?: string; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${Number.isInteger(value) ? value : value.toFixed(2)}`}</span>
    </div>
  ),
}));

import { DashboardKpiRow } from './dashboard-kpi-row';

const BASE_PROPS = {
  grossSalesToday: 20000,
  netSalesToday: 18500,
  transactionsToday: 120,
  profitToday: 6000,
  isProfitEstimated: false,
  missingCostItemCount: 0,
  isLoading: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardKpiRow', () => {
  it('renders Gross Sales, Net Sales, Transactions, and Profit Today', () => {
    render(<DashboardKpiRow {...BASE_PROPS} />);

    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱20000')).toBeInTheDocument();
    expect(screen.getByText('Net Sales')).toBeInTheDocument();
    expect(screen.getByText('₱18500')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Profit Today')).toBeInTheDocument();
    expect(screen.getByText('₱6000')).toBeInTheDocument();
  });

  it('labels the profit card as estimated when cost data is missing', () => {
    render(<DashboardKpiRow {...BASE_PROPS} isProfitEstimated={true} missingCostItemCount={3} />);

    expect(screen.getByText('Estimated Profit Today')).toBeInTheDocument();
  });

  it('renders every card skeleton when isLoading is true', () => {
    render(<DashboardKpiRow {...BASE_PROPS} isLoading={true} />);

    expect(screen.getAllByText('loading')).toHaveLength(4);
  });

  it('defaults to 0 when values are undefined', () => {
    render(
      <DashboardKpiRow
        grossSalesToday={undefined}
        netSalesToday={undefined}
        transactionsToday={undefined}
        profitToday={undefined}
        isProfitEstimated={false}
        missingCostItemCount={0}
        isLoading={false}
      />,
    );

    expect(screen.getAllByText('₱0')).toHaveLength(3);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
