import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { BranchInventoryStockRow } from '@potato-corner/shared';

const { mockReplace, mockPush, searchParams, branchState, mockUseStock, mockUseAlerts } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockPush: vi.fn(),
  searchParams: { value: new URLSearchParams() },
  branchState: { activeBranchId: 'branch-1' as string | null },
  mockUseStock: vi.fn(),
  mockUseAlerts: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useSearchParams: () => searchParams.value,
}));
vi.mock('@/stores/branch.store', () => ({
  useBranchStore: (selector: (s: typeof branchState) => unknown) => selector(branchState),
}));
vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStock: mockUseStock,
  useBranchInventoryStockAlerts: mockUseAlerts,
  useInventoryStockRealtimeSync: vi.fn(),
}));

import { InventoryList } from './inventory-list';

function row(name: string, status: BranchInventoryStockRow['status']): BranchInventoryStockRow {
  return {
    inventory_item_id: `00000000-0000-4000-8000-${String(name.length).padStart(12, '0')}`,
    name,
    status,
    base_unit_code: 'g',
    quantity_on_hand: 1,
    quantity_reserved: 0,
    quantity_available: 1,
    consumed_today: 0,
    low_stock_threshold: 5,
    critical_threshold: 2,
  } as unknown as BranchInventoryStockRow;
}

const ROWS = [row('Healthy Fries', 'healthy'), row('Low Cheese', 'low'), row('Critical Salt', 'critical')];

beforeEach(() => {
  searchParams.value = new URLSearchParams();
  branchState.activeBranchId = 'branch-1';
  mockUseStock.mockReturnValue({ data: { branch_id: 'branch-1', items: ROWS }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseAlerts.mockReturnValue({ data: { branch_id: 'branch-1', alerts: [] } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryList status filter (POS-PERF-P47)', () => {
  it('shows every item without a filter', () => {
    render(<InventoryList basePath="/supervisor" />);
    for (const name of ['Healthy Fries', 'Low Cheese', 'Critical Salt']) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All items' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('?status=low shows only low items (what the Low Stock Items card counts)', () => {
    searchParams.value = new URLSearchParams('status=low');
    render(<InventoryList basePath="/supervisor" />);
    expect(screen.getByText('Low Cheese')).toBeInTheDocument();
    expect(screen.queryByText('Critical Salt')).not.toBeInTheDocument();
    expect(screen.queryByText('Healthy Fries')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 items')).toBeInTheDocument();
  });

  it('?status=alerts shows low and critical items (what the Inventory Alerts card counts)', () => {
    searchParams.value = new URLSearchParams('status=alerts');
    render(<InventoryList basePath="/supervisor" />);
    expect(screen.getByText('Low Cheese')).toBeInTheDocument();
    expect(screen.getByText('Critical Salt')).toBeInTheDocument();
    expect(screen.queryByText('Healthy Fries')).not.toBeInTheDocument();
  });

  it('ignores an unknown status value and updates the URL when a filter is chosen', () => {
    searchParams.value = new URLSearchParams('status=bogus');
    render(<InventoryList basePath="/supervisor" />);
    expect(screen.getByText('Healthy Fries')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Critical' }));
    expect(mockReplace).toHaveBeenCalledWith('/supervisor/inventory?status=critical', { scroll: false });
  });

  it('does not show rows answered for a previously selected branch', () => {
    branchState.activeBranchId = 'branch-2';
    render(<InventoryList basePath="/supervisor" />);
    expect(screen.queryByText('Low Cheese')).not.toBeInTheDocument();
  });

  it('offers a way back when a filter matches nothing', () => {
    searchParams.value = new URLSearchParams('status=critical');
    mockUseStock.mockReturnValue({ data: { branch_id: 'branch-1', items: [ROWS[0]] }, isLoading: false, isError: false, refetch: vi.fn() });
    render(<InventoryList basePath="/supervisor" />);
    expect(screen.getByText('No items match this filter')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(mockReplace).toHaveBeenCalledWith('/supervisor/inventory');
  });
});
