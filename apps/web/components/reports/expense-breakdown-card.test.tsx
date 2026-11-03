import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ExpenseBreakdownCard } from './expense-breakdown-card';

const { mockUseExpenseSummary } = vi.hoisted(() => ({ mockUseExpenseSummary: vi.fn() }));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpenseSummary: mockUseExpenseSummary,
}));

const TYPE_ID = '223e4567-e89b-12d3-a456-426614174000';
const SUMMARY = {
  total: 7,
  total_amount: 1234.5,
  groups: [
    { key: `type:${TYPE_ID}`, kind: 'type', expense_type_id: TYPE_ID, category: null, name: 'Bills', is_active: false, count: 5, total_amount: 1000 },
    { key: 'legacy:utilities', kind: 'legacy', expense_type_id: null, category: 'utilities', name: 'Utilities (legacy)', is_active: null, count: 2, total_amount: 234.5 },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExpenseBreakdownCard', () => {
  it('reads one summary with the given filters and links each line to its filtered ledger', () => {
    mockUseExpenseSummary.mockReturnValue({ data: SUMMARY, isLoading: false, isError: false, refetch: vi.fn() });
    render(<ExpenseBreakdownCard title="Today" branchId="b1" dateFrom="2026-11-03" dateTo="2026-11-03" ledgerPath="/admin/expenses" />);

    expect(mockUseExpenseSummary).toHaveBeenCalledWith({ branch_id: 'b1', date_from: '2026-11-03', date_to: '2026-11-03' }, { enabled: true });
    expect(screen.getByTestId('expense-breakdown-total')).toHaveTextContent('across 7 records');
    expect(screen.getByRole('link', { name: /bills/i })).toHaveAttribute('href', `/admin/expenses?branch_id=b1&date_from=2026-11-03&date_to=2026-11-03&expense_type_id=${TYPE_ID}`);
    expect(screen.getByRole('link', { name: /utilities \(legacy\)/i })).toHaveAttribute('href', '/admin/expenses?branch_id=b1&date_from=2026-11-03&date_to=2026-11-03&category=utilities');
    expect(screen.getByText('Deactivated')).toBeInTheDocument();
  });

  it('says so when nothing was recorded, and offers a retry on failure instead of showing zero', () => {
    mockUseExpenseSummary.mockReturnValue({ data: { total: 0, total_amount: 0, groups: [] }, isLoading: false, isError: false, refetch: vi.fn() });
    const first = render(<ExpenseBreakdownCard title="Today" />);
    expect(screen.getByText('No expenses recorded for this period.')).toBeInTheDocument();
    first.unmount();

    const refetch = vi.fn();
    mockUseExpenseSummary.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<ExpenseBreakdownCard title="Today" />);
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByTestId('expense-breakdown-total')).not.toBeInTheDocument();
  });
});
