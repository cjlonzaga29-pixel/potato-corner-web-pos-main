import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ShiftResponse } from '@potato-corner/shared';
import { DashboardShiftCard } from './dashboard-shift-card';

afterEach(cleanup);

function shift(overrides: Partial<ShiftResponse> = {}): ShiftResponse {
  return {
    id: 'shift-1',
    branch_id: 'branch-1',
    cashier_id: 'cashier-1234-5678',
    opened_by: 'supervisor-1',
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
    ...overrides,
  };
}

describe('DashboardShiftCard', () => {
  it('renders a skeleton while loading', () => {
    const { container } = render(<DashboardShiftCard shift={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the no-active-shift empty state when shift is null', () => {
    render(<DashboardShiftCard shift={null} isLoading={false} />);
    expect(screen.getByText('No active shift')).toBeInTheDocument();
    expect(screen.getByText('Open a shift from the POS terminal to begin tracking sales')).toBeInTheDocument();
  });

  it('renders shift details when a shift is provided', () => {
    render(<DashboardShiftCard shift={shift()} isLoading={false} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/cashier-123/)).toBeInTheDocument();
    expect(screen.getByText('₱1,500.00')).toBeInTheDocument();
  });

  it('renders the FLAGGED status badge when the shift is flagged', () => {
    render(<DashboardShiftCard shift={shift({ status: 'flagged' })} isLoading={false} />);
    expect(screen.getByText('Flagged').className).toContain('bg-destructive/15');
  });
});
