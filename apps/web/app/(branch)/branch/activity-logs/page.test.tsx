import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BranchActivityLogsPage from './page';

const { mockUseShifts, mockUseBranchStore } = vi.hoisted(() => ({
  mockUseShifts: vi.fn(),
  mockUseBranchStore: vi.fn(),
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShifts: mockUseShifts,
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchActivityLogsPage — P1 cost/audit UI retirement', () => {
  it('has no Audit Log tab or table — Historical Shift Records renders directly with no tab bar', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: 'branch-1' }));
    mockUseShifts.mockReturnValue({
      data: {
        shifts: [
          {
            id: 'shift-1',
            branch_id: 'branch-1',
            cashier_id: 'user-1',
            status: 'closed',
            started_at: '2026-07-20T00:00:00.000Z',
            closed_at: '2026-07-20T08:00:00.000Z',
            transaction_count: 5,
            cash_sales_total: 500,
            gcash_sales_total: 0,
            total_discount_amount: 0,
            opening_cash_amount: 1000,
            closing_cash_amount: 1500,
            expected_closing_cash: 1500,
            cash_variance: 0,
            variance_approved: true,
            variance_approved_by: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<BranchActivityLogsPage />);

    expect(screen.queryByRole('tab', { name: 'Audit Log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Historical Shift Records' })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });
});
