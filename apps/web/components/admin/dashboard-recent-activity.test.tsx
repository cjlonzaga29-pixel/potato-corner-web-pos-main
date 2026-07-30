import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockUseDashboardRecentTransactions, mockUseBranches } = vi.hoisted(() => ({
  mockUseDashboardRecentTransactions: vi.fn(),
  mockUseBranches: vi.fn(),
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useDashboardRecentTransactions: mockUseDashboardRecentTransactions,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { DashboardRecentActivity } from './dashboard-recent-activity';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function txn(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    receipt_number: 'PC-0001',
    branch_id: 'b1',
    status: 'completed',
    payment_method: 'cash',
    total_amount: 250,
    created_at: '2026-07-31T02:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardRecentActivity', () => {
  it('caps the preview at 5 rows even when more are returned, and links "View All" to Reports', () => {
    mockUseDashboardRecentTransactions.mockReturnValue({
      data: { transactions: Array.from({ length: 8 }, (_, i) => txn({ id: `t${i}`, receipt_number: `PC-000${i}` })), total: 8, page: 1, limit: 8 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseBranches.mockReturnValue({ data: { branches: [{ id: 'b1', name: 'Puregold GMA', status: 'active' }], total: 1, page: 1, limit: 500 }, isLoading: false });

    render(<DashboardRecentActivity branchId={undefined} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('View All').closest('a')).toHaveAttribute('href', '/admin/reports');
  });

  it('resolves the branch name for each transaction from the branch list', () => {
    mockUseDashboardRecentTransactions.mockReturnValue({
      data: { transactions: [txn({ branch_id: 'b1' })], total: 1, page: 1, limit: 5 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseBranches.mockReturnValue({ data: { branches: [{ id: 'b1', name: 'Puregold GMA', status: 'active' }], total: 1, page: 1, limit: 500 }, isLoading: false });

    render(<DashboardRecentActivity branchId={undefined} />);

    expect(screen.getByText(/Puregold GMA/)).toBeInTheDocument();
  });

  it('renders an empty state when there is no recent activity', () => {
    mockUseDashboardRecentTransactions.mockReturnValue({ data: { transactions: [], total: 0, page: 1, limit: 5 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseBranches.mockReturnValue({ data: { branches: [], total: 0, page: 1, limit: 500 }, isLoading: false });

    render(<DashboardRecentActivity branchId={undefined} />);
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('renders an error state with retry', () => {
    mockUseDashboardRecentTransactions.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    mockUseBranches.mockReturnValue({ data: undefined, isLoading: false });

    render(<DashboardRecentActivity branchId={undefined} />);
    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
