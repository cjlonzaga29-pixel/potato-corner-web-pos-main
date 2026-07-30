import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseBranchComparisonReport, mockUseBranches } = vi.hoisted(() => ({
  mockUseBranchComparisonReport: vi.fn(),
  mockUseBranches: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useBranchComparisonReport: mockUseBranchComparisonReport,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

import { DashboardBranchPerformanceTable } from './dashboard-branch-performance-table';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockDefaults() {
  mockUseBranchComparisonReport.mockReturnValue({
    data: {
      data: [
        { branch_id: 'b1', branch_name: 'Puregold GMA', gross_sales: 500, transaction_count: 2, active_shift_count: 1, low_stock_ingredient_count: 0 },
        { branch_id: 'b2', branch_name: 'SM North', gross_sales: 1500, transaction_count: 5, active_shift_count: 0, low_stock_ingredient_count: 3 },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseBranches.mockReturnValue({
    data: { branches: [{ id: 'b1', name: 'Puregold GMA', status: 'active' }, { id: 'b2', name: 'SM North', status: 'inactive' }], total: 2, page: 1, limit: 500 },
    isLoading: false,
    isError: false,
  });
}

describe('DashboardBranchPerformanceTable', () => {
  it('sorts branches by gross sales, highest first', () => {
    mockDefaults();
    render(<DashboardBranchPerformanceTable />);

    const rows = screen.getAllByRole('row');
    // rows[0] is the header row.
    expect(rows[1]).toHaveTextContent('SM North');
    expect(rows[2]).toHaveTextContent('Puregold GMA');
  });

  it('filters to a single branch when branchId is given', () => {
    mockDefaults();
    render(<DashboardBranchPerformanceTable branchId="b1" />);

    expect(screen.getByText('Puregold GMA')).toBeInTheDocument();
    expect(screen.queryByText('SM North')).not.toBeInTheDocument();
  });

  it('renders an empty state when there is no branch activity', () => {
    mockUseBranchComparisonReport.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseBranches.mockReturnValue({ data: { branches: [], total: 0, page: 1, limit: 500 }, isLoading: false, isError: false });
    render(<DashboardBranchPerformanceTable />);
    expect(screen.getByText('No branch activity yet')).toBeInTheDocument();
  });

  it('renders an error state with retry', () => {
    mockUseBranchComparisonReport.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    mockUseBranches.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<DashboardBranchPerformanceTable />);
    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
