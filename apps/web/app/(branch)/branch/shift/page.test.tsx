import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ShiftResponse } from '@potato-corner/shared';
import ShiftDashboardPage from './page';

const { mockUseAuth, mockUseCurrentShift } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseCurrentShift: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useCurrentShift: mockUseCurrentShift,
}));

function shift(overrides: Partial<ShiftResponse> = {}): ShiftResponse {
  return {
    id: 'shift-1',
    branch_id: 'branch-1',
    cashier_id: 'staff-1',
    opened_by: 'staff-1',
    closed_by: null,
    status: 'active',
    opening_cash_amount: 1500,
    closing_cash_amount: null,
    expected_closing_cash: null,
    cash_variance: null,
    variance_approved: null,
    variance_explanation: null,
    variance_approved_by: null,
    variance_approval_reason: null,
    cash_sales_total: 0,
    gcash_sales_total: 0,
    maya_sales_total: 0,
    other_sales_total: 0,
    gross_sales_total: 0,
    transaction_count: 0,
    cash_sales_count: 0,
    gcash_sales_count: 0,
    maya_sales_count: 0,
    other_sales_count: 0,
    voided_count: 0,
    refunded_count: 0,
    total_transaction_count: 0,
    total_discount_amount: 0,
    pwd_sc_transaction_count: 0,
    shift_notes: null,
    started_at: '2026-07-16T02:32:00.000Z',
    closed_at: null,
    denominations: [],
    ...overrides,
  } as ShiftResponse;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ShiftDashboardPage — cashier mismatch warning', () => {
  it('shows no warning when the active shift belongs to the logged-in cashier', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'staff-1', branchIds: ['branch-1'] } });
    mockUseCurrentShift.mockReturnValue({
      data: shift({ cashier_id: 'staff-1' }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ShiftDashboardPage />);

    expect(screen.getByText('Current Shift')).toBeInTheDocument();
    expect(screen.queryByText(/open under a different cashier account/i)).not.toBeInTheDocument();
  });

  it('shows a warning when the active shift belongs to a different cashier than the logged-in account', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'staff-1', branchIds: ['branch-1'] } });
    mockUseCurrentShift.mockReturnValue({
      data: shift({ cashier_id: 'staff-2' }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ShiftDashboardPage />);

    expect(screen.getByText(/open under a different cashier account/i)).toBeInTheDocument();
  });
});
