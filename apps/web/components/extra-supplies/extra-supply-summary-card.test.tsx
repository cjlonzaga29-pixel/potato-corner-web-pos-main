import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ExtraSupplySummaryResponse } from '@potato-corner/shared';
import { ExtraSupplySummaryCard } from './extra-supply-summary-card';

const mockSummary = vi.fn();
vi.mock('@/hooks/queries/use-extra-supplies', () => ({ useExtraSupplySummary: (...args: unknown[]) => mockSummary(...args) }));

function summary(overrides: Partial<ExtraSupplySummaryResponse> = {}): ExtraSupplySummaryResponse {
  return {
    issue_count: 3,
    units_free: 4,
    units_paid: 5,
    amount_collected: 25,
    inventory_cost: 18,
    configured_cost: 0,
    unknown_cost_lines: 0,
    by_payment_method: [{ payment_method: 'cash', amount: 25, line_count: 1 }],
    by_branch: [],
    by_supply: [],
    by_cashier: [],
    product_sales_total: 100,
    combined_collection_total: 125,
    ...overrides,
  };
}

describe('ExtraSupplySummaryCard', () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it('states product sales and supply collections apart, with the combined total defined', () => {
    mockSummary.mockReturnValue({ data: summary(), isLoading: false, isError: false });
    render(<ExtraSupplySummaryCard title="Today" branchId="b1" dateFrom="2026-11-03" dateTo="2026-11-03" historyPath="/branch/extra-supplies" />);
    expect(screen.getByTestId('summary-units-free')).toHaveTextContent('4 units');
    expect(screen.getByTestId('summary-units-paid')).toHaveTextContent('5 units');
    expect(screen.getByTestId('summary-collected')).toHaveTextContent('25.00');
    expect(screen.getByTestId('summary-combined')).toHaveTextContent('100.00');
    expect(screen.getByTestId('summary-combined')).toHaveTextContent('125.00');
    expect(screen.getByRole('link', { name: /view history/i })).toHaveAttribute('href', '/branch/extra-supplies?branch_id=b1&date_from=2026-11-03&date_to=2026-11-03');
    expect(mockSummary).toHaveBeenCalledWith({ branchId: 'b1', dateFrom: '2026-11-03', dateTo: '2026-11-03' }, { enabled: true });
  });

  it('merges the scope into a history path that already carries a query (Admin opens the Reports tab)', () => {
    mockSummary.mockReturnValue({ data: summary(), isLoading: false, isError: false });
    render(<ExtraSupplySummaryCard title="Today" branchId="b1" dateFrom="2026-11-03" dateTo="2026-11-04" historyPath="/admin/reports?tab=EXTRA_SUPPLIES" />);
    expect(screen.getByRole('link', { name: /view history/i })).toHaveAttribute(
      'href',
      '/admin/reports?tab=EXTRA_SUPPLIES&branch_id=b1&date_from=2026-11-03&date_to=2026-11-04',
    );
  });

  it('keeps a query-carrying history path as-is when there is no scope to add', () => {
    mockSummary.mockReturnValue({ data: summary(), isLoading: false, isError: false });
    render(<ExtraSupplySummaryCard title="Today" historyPath="/admin/reports?tab=EXTRA_SUPPLIES" />);
    expect(screen.getByRole('link', { name: /view history/i })).toHaveAttribute('href', '/admin/reports?tab=EXTRA_SUPPLIES');
  });

  it('labels stated costs apart from inventory cost, and counts unknown costs instead of showing zero', () => {
    mockSummary.mockReturnValue({ data: summary({ configured_cost: 7.5, unknown_cost_lines: 2 }), isLoading: false, isError: false });
    render(<ExtraSupplySummaryCard title="Today" historyPath="/branch/extra-supplies" />);
    const card = screen.getByTestId('extra-supply-summary-card');
    expect(card).toHaveTextContent('From inventory cost');
    expect(card).toHaveTextContent('7.50 stated on cards');
    expect(card).toHaveTextContent('2 lines have no known cost');
  });

  it('shows unavailable rather than false zeros when the read fails', () => {
    mockSummary.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<ExtraSupplySummaryCard title="Today" historyPath="/branch/extra-supplies" />);
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.queryByTestId('summary-collected')).not.toBeInTheDocument();
  });

  it('an empty period says so, and still shows product sales', () => {
    mockSummary.mockReturnValue({ data: summary({ issue_count: 0, units_free: 0, units_paid: 0, amount_collected: 0, combined_collection_total: 100 }), isLoading: false, isError: false });
    render(<ExtraSupplySummaryCard title="Today" historyPath="/branch/extra-supplies" />);
    expect(screen.getByText(/no extra supplies issued/i)).toBeInTheDocument();
    expect(screen.getByText(/product sales/i)).toHaveTextContent('100.00');
  });
});
