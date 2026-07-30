import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ShiftResponse, ShiftReviewResponse } from '@potato-corner/shared';
import { ShiftDetailView } from './shift-detail-view';

const { mockUseAuth, mockUseShift, mockUseShiftSummary, mockUseShiftReviews } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseShift: vi.fn(),
  mockUseShiftSummary: vi.fn(),
  mockUseShiftReviews: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ shiftId: 'shift-1' }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShift: mockUseShift,
  useShiftSummary: mockUseShiftSummary,
  useShiftsRealtimeSync: () => undefined,
  useShiftReviews: mockUseShiftReviews,
  useShiftReviewsRealtimeSync: () => undefined,
  useApproveVariance: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: () => ({ data: { transactions: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() }),
  useTransactionsRealtimeSync: () => undefined,
  usePaymentProof: () => ({ data: undefined, isLoading: false, isError: false }),
}));

function shift(overrides: Partial<ShiftResponse> = {}): ShiftResponse {
  return {
    id: 'shift-1',
    branch_id: 'branch-1',
    cashier_id: 'staff-1',
    opened_by: 'supervisor-1',
    closed_by: null,
    status: 'flagged',
    opening_cash_amount: 1500,
    closing_cash_amount: 1400,
    expected_closing_cash: 1500,
    cash_variance: -100,
    variance_approved: null,
    variance_explanation: 'Drawer short at count',
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
    closed_at: '2026-07-16T10:00:00.000Z',
    denominations: [],
    ...overrides,
  } as ShiftResponse;
}

function review(overrides: Partial<ShiftReviewResponse> = {}): ShiftReviewResponse {
  return {
    id: 'review-1',
    shift_id: 'shift-1',
    phase: 'opening',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
    created_at: '2026-07-16T02:32:00.000Z',
    updated_at: '2026-07-16T02:32:00.000Z',
    ...overrides,
  } as ShiftReviewResponse;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUseShiftSummary.mockReturnValue({ data: undefined });
  mockUseShiftReviews.mockReturnValue({ data: [] });
});

describe('ShiftDetailView — variance review permission gate', () => {
  it('shows the Review Variance button for a supervisor (CR-003: widened from super_admin-only)', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'supervisor-1', role: 'supervisor' } });
    mockUseShift.mockReturnValue({ data: shift(), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseShiftSummary.mockReturnValue({ data: undefined });
    mockUseShiftReviews.mockReturnValue({ data: [review({ phase: 'opening' }), review({ id: 'review-2', phase: 'closing' })] });

    render(<ShiftDetailView />);

    expect(screen.getByRole('button', { name: /review variance/i })).toBeInTheDocument();
    expect(screen.queryByText(/only a super admin or authorized supervisor/i)).not.toBeInTheDocument();
  });

  it('hides the Review Variance button and shows the restriction notice for staff', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'staff-1', role: 'staff' } });
    mockUseShift.mockReturnValue({ data: shift(), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseShiftReviews.mockReturnValue({ data: [review({ phase: 'opening' }), review({ id: 'review-2', phase: 'closing' })] });

    render(<ShiftDetailView />);

    expect(screen.queryByRole('button', { name: /review variance/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only a super admin or authorized supervisor/i)).toBeInTheDocument();
  });
});

describe('ShiftDetailView — Shift Reviews card', () => {
  it('shows Pending status and a Review button for a pending opening review, for an authorized reviewer', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'admin-1', role: 'super_admin' } });
    mockUseShift.mockReturnValue({ data: shift({ status: 'active' }), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseShiftReviews.mockReturnValue({
      data: [review({ phase: 'opening', status: 'pending' }), review({ id: 'review-2', phase: 'closing', status: 'pending' })],
    });

    render(<ShiftDetailView />);

    expect(screen.getByText('Opening Shift Review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review opening/i })).toBeInTheDocument();
    // Closing isn't reviewable yet — shift is still active.
    expect(screen.queryByRole('button', { name: /review closing/i })).not.toBeInTheDocument();
    expect(screen.getByText(/available once the shift is closed/i)).toBeInTheDocument();
  });

  it('shows Approved status with reviewer and reviewed date once a review has been decided', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'admin-1', role: 'super_admin' } });
    mockUseShift.mockReturnValue({ data: shift({ status: 'closed' }), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseShiftReviews.mockReturnValue({
      data: [
        review({ phase: 'opening', status: 'approved', reviewed_by: 'admin-1', reviewed_at: '2026-07-16T03:00:00.000Z' }),
        review({ id: 'review-2', phase: 'closing', status: 'pending' }),
      ],
    });

    render(<ShiftDetailView />);

    expect(screen.getAllByText('Approved')).toHaveLength(1);
    expect(screen.getByText(/reviewer: admin-1/i)).toBeInTheDocument();
    // Approved review has no action button.
    expect(screen.queryByRole('button', { name: /review opening/i })).not.toBeInTheDocument();
  });

  it('hides Review buttons entirely for a non-reviewer role even when reviews are pending', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'staff-1', role: 'staff' } });
    mockUseShift.mockReturnValue({ data: shift({ status: 'closed' }), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseShiftReviews.mockReturnValue({
      data: [review({ phase: 'opening', status: 'pending' }), review({ id: 'review-2', phase: 'closing', status: 'pending' })],
    });

    render(<ShiftDetailView />);

    expect(screen.queryByRole('button', { name: /review opening/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review closing/i })).not.toBeInTheDocument();
  });
});
