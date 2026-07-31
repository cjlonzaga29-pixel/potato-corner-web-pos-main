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
  isLoadingToday: false,
  isLoadingMonth: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardKpiRow', () => {
  it('renders Daily Gross Sales and Monthly Gross Sales', () => {
    render(<DashboardKpiRow {...BASE_PROPS} />);

    expect(screen.getByText('Daily Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱20000')).toBeInTheDocument();
    expect(screen.getByText('Monthly Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱450000')).toBeInTheDocument();
  });

  it('renders each card skeleton independently based on its own isLoading prop', () => {
    render(<DashboardKpiRow {...BASE_PROPS} isLoadingToday={true} isLoadingMonth={false} />);

    expect(screen.getByText('Daily Gross Sales').closest('div')?.textContent).toContain('loading');
    expect(screen.getByText('Monthly Gross Sales').closest('div')?.textContent).not.toContain('loading');
  });

  it('defaults to 0 when values are undefined', () => {
    render(<DashboardKpiRow grossSalesToday={undefined} grossSalesMonth={undefined} isLoadingToday={false} isLoadingMonth={false} />);

    expect(screen.getAllByText('₱0')).toHaveLength(2);
  });
});
