import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { TransactionResponse } from '@potato-corner/shared';
import { DashboardTransactionsFeed } from './dashboard-transactions-feed';

afterEach(cleanup);

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: 'txn-1',
    receipt_number: 'PC-MNL-20260716-0001',
    branch_id: 'branch-1',
    shift_id: 'shift-1',
    cashier_id: 'cashier-1',
    status: 'completed',
    payment_method: 'cash',
    subtotal: 100,
    discount_amount: 0,
    discount_type: null,
    vat_amount: 10.71,
    vat_exempt_amount: 0,
    total_amount: 100,
    cash_tendered: 100,
    change_given: 0,
    gcash_reference_number: null,
    gcash_manually_verified: null,
    receipt_printed: true,
    inventory_deduction_status: 'completed',
    is_offline_transaction: false,
    offline_provisional_number: null,
    synced_at: null,
    voided_at: null,
    voided_by_id: null,
    void_reason: null,
    refunded_at: null,
    refunded_by_id: null,
    refund_reason: null,
    created_at: '2026-07-16T02:00:00.000Z',
    updated_at: '2026-07-16T02:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardTransactionsFeed', () => {
  it('renders skeleton rows while loading', () => {
    const { container } = render(<DashboardTransactionsFeed transactions={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the no-transactions empty state', () => {
    render(<DashboardTransactionsFeed transactions={[]} isLoading={false} />);
    expect(screen.getByText('No transactions this shift')).toBeInTheDocument();
  });

  it('renders receipt number, payment method, and total amount for each transaction', () => {
    render(<DashboardTransactionsFeed transactions={[transaction()]} isLoading={false} />);
    expect(screen.getByText('PC-MNL-20260716-0001')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('₱100.00')).toBeInTheDocument();
  });

  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn();
    render(<DashboardTransactionsFeed transactions={[transaction()]} isLoading={false} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('PC-MNL-20260716-0001'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});
