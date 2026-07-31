import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AuditLogResponse } from '@potato-corner/shared';
import BranchActivityLogsPage from './page';

const { mockUseAuditLogs, mockUseShifts, mockUseBranchStore } = vi.hoisted(() => ({
  mockUseAuditLogs: vi.fn(),
  mockUseShifts: vi.fn(),
  mockUseBranchStore: vi.fn(),
}));

vi.mock('@/hooks/queries/use-audit-logs', () => ({
  useAuditLogs: mockUseAuditLogs,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShifts: mockUseShifts,
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

function log(overrides: Partial<AuditLogResponse> = {}): AuditLogResponse {
  return {
    id: 'log-1',
    action: 'SHIFT_OPENED',
    entity_type: 'shift',
    entity_id: 'shift-1',
    actor_id: 'user-1',
    actor_role: 'staff',
    branch_id: 'branch-1',
    before_state: null,
    after_state: null,
    ip_address: '127.0.0.1',
    created_at: '2026-07-30T08:00:00.000Z',
    ...overrides,
  } as AuditLogResponse;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchActivityLogsPage — pagination', () => {
  it('requests page 1 with a 25-row page size by default (not the old fixed limit of 50)', () => {
    mockUseAuditLogs.mockReturnValue({ data: { logs: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<BranchActivityLogsPage />);

    expect(mockUseAuditLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 25 }));
  });

  it('shows pagination controls and requests the next page when there are more rows than fit on one page', () => {
    mockUseAuditLogs.mockReturnValue({
      data: { logs: [log()], total: 60 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<BranchActivityLogsPage />);

    expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(mockUseAuditLogs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, limit: 25 }));
  });
});

describe('BranchActivityLogsPage — Historical Shift Records (Reports §8/§9, read-only)', () => {
  it('shows a read-only historical shift tab, not a primary Reports option, with no approve/reject controls', () => {
    mockUseAuditLogs.mockReturnValue({ data: { logs: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() });
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
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Historical Shift Records' }));

    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });
});
