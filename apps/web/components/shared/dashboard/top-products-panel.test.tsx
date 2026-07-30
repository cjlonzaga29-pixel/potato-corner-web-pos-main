import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseDashboardProductPerformanceReport } = vi.hoisted(() => ({
  mockUseDashboardProductPerformanceReport: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardProductPerformanceReport: mockUseDashboardProductPerformanceReport,
}));

import { TopProductsPanel } from './top-products-panel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TopProductsPanel', () => {
  it('shows the top 5 products by revenue, highest first', () => {
    mockUseDashboardProductPerformanceReport.mockReturnValue({
      data: {
        data: Array.from({ length: 7 }, (_, i) => ({
          product_variant_id: `v${i}`,
          product_name: `Product ${i}`,
          variant_name: 'Regular',
          units_sold: i,
          gross_revenue: i * 100,
          transaction_count: i,
        })),
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<TopProductsPanel branchId={undefined} />);

    expect(screen.getByText('Product 6')).toBeInTheDocument();
    expect(screen.getByText('Product 2')).toBeInTheDocument();
    expect(screen.queryByText('Product 1')).not.toBeInTheDocument();
  });

  it('renders an empty state when there is no sales data', () => {
    mockUseDashboardProductPerformanceReport.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false, refetch: vi.fn() });
    render(<TopProductsPanel branchId="branch-1" />);
    expect(screen.getByText('No sales yet')).toBeInTheDocument();
  });

  it('renders an error state with retry', () => {
    const refetch = vi.fn();
    mockUseDashboardProductPerformanceReport.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<TopProductsPanel branchId={undefined} />);
    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
