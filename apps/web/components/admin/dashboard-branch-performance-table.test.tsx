import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { BranchPresenceResponse, BranchStatsOverview } from '@/hooks/queries/use-branches';
import { DashboardBranchPerformanceTable, buildBranchPerformanceRows } from './dashboard-branch-performance-table';

afterEach(() => {
  cleanup();
});

const EMPTY_PAYMENTS = { cash: { total: 0, count: 0 }, gcash: { total: 0, count: 0 }, maya: { total: 0, count: 0 }, other: { total: 0, count: 0 } };

function stats(branchId: string, todayGrossSales: number, todayTransactionCount: number): BranchStatsOverview {
  return {
    branchId,
    activeShiftsCount: 1,
    activeStaffCount: 2,
    staffTimedInCount: 1,
    todayGrossSales,
    todayDiscountTotal: 0,
    todayRefundTotal: 0,
    todayNetSales: todayGrossSales,
    todayVat: 0,
    todayExpenses: 0,
    todayNetOperatingResult: todayGrossSales,
    paymentBreakdown: EMPTY_PAYMENTS,
    todayTransactionCount,
    lowStockIngredientCount: 0,
  };
}

const BRANCHES = [
  { id: 'b1', name: 'Puregold GMA', code: 'GMA-001', status: 'active' as const },
  { id: 'b2', name: 'SM North', code: 'SMN-001', status: 'active' as const },
  { id: 'b3', name: 'Old Branch', code: 'OLD-001', status: 'closed' as const },
];
const STATS = [stats('b1', 500, 2), stats('b2', 1500, 5)];
const PRESENCE: BranchPresenceResponse = {
  available: true,
  checked_at: '2026-10-27T00:00:00.000Z',
  branches: [
    { branch_id: 'b1', connectivity: 'online', connected_sessions: 1 },
    { branch_id: 'b2', connectivity: 'offline', connected_sessions: 0 },
    { branch_id: 'b3', connectivity: 'offline', connected_sessions: 0 },
  ],
};

function renderTable(overrides: Partial<Parameters<typeof DashboardBranchPerformanceTable>[0]> = {}) {
  return render(
    <DashboardBranchPerformanceTable
      branches={BRANCHES}
      stats={STATS}
      presence={PRESENCE}
      businessDate="2026-10-27"
      isLoading={false}
      isError={false}
      onRetry={vi.fn()}
      {...overrides}
    />,
  );
}

describe('buildBranchPerformanceRows', () => {
  it('uses the same live per-branch stats the KPI row sums, so the totals reconcile', () => {
    const rows = buildBranchPerformanceRows(BRANCHES, STATS, PRESENCE);
    const grossTotal = rows.reduce((sum, row) => sum + (row.grossSales ?? 0), 0);
    const kpiGross = STATS.reduce((sum, s) => sum + s.todayGrossSales, 0);
    expect(grossTotal).toBe(kpiGross);
    expect(rows.find((r) => r.branchId === 'b2')?.averageOrderValue).toBe(300);
  });

  it('keeps administrative status and connectivity independent', () => {
    const rows = buildBranchPerformanceRows(BRANCHES, STATS, PRESENCE);
    const sm = rows.find((r) => r.branchId === 'b2');
    expect(sm?.status).toBe('active');
    expect(sm?.connectivity).toBe('offline');
  });

  it('shows a branch without live stats (not active) with null figures instead of zeros', () => {
    const closed = buildBranchPerformanceRows(BRANCHES, STATS, PRESENCE).find((r) => r.branchId === 'b3');
    expect(closed?.grossSales).toBeNull();
    expect(closed?.transactionCount).toBeNull();
  });

  it('reports connectivity as unknown when presence is unavailable, never as offline', () => {
    const rows = buildBranchPerformanceRows(BRANCHES, STATS, { available: false, checked_at: '', branches: [] });
    expect(rows.every((r) => r.connectivity === 'unknown')).toBe(true);
  });
});

describe('DashboardBranchPerformanceTable', () => {
  it('sorts branches by gross sales, highest first, with branches lacking figures last', () => {
    renderTable();
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('SM North');
    expect(rows[2]).toHaveTextContent('Puregold GMA');
    expect(rows[3]).toHaveTextContent('Old Branch');
  });

  it('states the date and branch scope', () => {
    renderTable();
    expect(screen.getByText(/Today, 2026-10-27 \(Manila\) · All branches \(3\)/)).toBeInTheDocument();
  });

  it('filters to a single branch when branchId is given and names it in the scope', () => {
    renderTable({ branchId: 'b1', branchName: 'Puregold GMA' });
    expect(screen.getAllByText('Puregold GMA').length).toBeGreaterThan(0);
    expect(screen.queryByText('SM North')).not.toBeInTheDocument();
    expect(screen.getByText(/Today, 2026-10-27 \(Manila\) · Puregold GMA/)).toBeInTheDocument();
  });

  it('shows status and connection as separate columns', () => {
    renderTable();
    const smRow = screen.getByText('SM North').closest('tr') as HTMLElement;
    expect(within(smRow).getByText('Offline')).toBeInTheDocument();
    expect(within(smRow).getByText(/active/i)).toBeInTheDocument();
  });

  it('renders an empty state when there are no branches', () => {
    renderTable({ branches: [], stats: [] });
    expect(screen.getByText('No branches')).toBeInTheDocument();
  });

  it('renders an error state with retry', () => {
    renderTable({ isError: true });
    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
