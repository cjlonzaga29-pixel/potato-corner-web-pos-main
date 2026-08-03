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
  grossSalesMonth: 450000,
  transactionsToday: 120,
  averageOrderValue: 166.67,
  isLoading: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardKpiRow', () => {
  it('renders Gross Sales Today, Gross Sales This Month, Today\'s Transactions, and Average Order Value', () => {
    render(<DashboardKpiRow {...BASE_PROPS} />);

    expect(screen.getByText('Gross Sales Today')).toBeInTheDocument();
    expect(screen.getByText('₱20000')).toBeInTheDocument();
    expect(screen.getByText('Gross Sales This Month')).toBeInTheDocument();
    expect(screen.getByText('₱450000')).toBeInTheDocument();
    expect(screen.getByText("Today's Transactions")).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Average Order Value')).toBeInTheDocument();
    expect(screen.getByText('₱166.67')).toBeInTheDocument();
  });

  it('never renders Net Sales or (Estimated) Profit — removed in TASK 165', () => {
    render(<DashboardKpiRow {...BASE_PROPS} />);

    expect(screen.queryByText('Net Sales')).not.toBeInTheDocument();
    expect(screen.queryByText(/Profit/)).not.toBeInTheDocument();
  });

  it('renders every card skeleton when isLoading is true', () => {
    render(<DashboardKpiRow {...BASE_PROPS} isLoading={true} />);

    expect(screen.getAllByText('loading')).toHaveLength(4);
  });

  it('defaults to 0 when values are undefined', () => {
    render(
      <DashboardKpiRow
        grossSalesToday={undefined}
        grossSalesMonth={undefined}
        transactionsToday={undefined}
        averageOrderValue={undefined}
        isLoading={false}
      />,
    );

    expect(screen.getAllByText('₱0')).toHaveLength(3);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
