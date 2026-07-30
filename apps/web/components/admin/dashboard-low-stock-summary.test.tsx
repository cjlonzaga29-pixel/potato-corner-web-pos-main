import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockUseAdminInventoryRollup, mockUseAdminInventoryRollupRealtimeSync } = vi.hoisted(() => ({
  mockUseAdminInventoryRollup: vi.fn(),
  mockUseAdminInventoryRollupRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-admin-inventory-rollup', () => ({
  useAdminInventoryRollup: mockUseAdminInventoryRollup,
  useAdminInventoryRollupRealtimeSync: mockUseAdminInventoryRollupRealtimeSync,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { DashboardLowStockSummary } from './dashboard-low-stock-summary';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function branch(overrides: Record<string, unknown>) {
  return {
    branch_id: 'b1',
    branch_name: 'Branch',
    inventory_item_count: 10,
    total_inventory_value: 1000,
    low_stock_count: 0,
    critical_stock_count: 0,
    out_of_stock_count: 0,
    last_movement_at: null,
    ...overrides,
  };
}

describe('DashboardLowStockSummary', () => {
  it('ranks affected branches by low+critical stock count, highest first, and links to Inventory', () => {
    mockUseAdminInventoryRollup.mockReturnValue({
      data: {
        branches: [
          branch({ branch_id: 'b1', branch_name: 'Low Branch', low_stock_count: 1 }),
          branch({ branch_id: 'b2', branch_name: 'Critical Branch', low_stock_count: 2, critical_stock_count: 5 }),
          branch({ branch_id: 'b3', branch_name: 'Healthy Branch' }),
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<DashboardLowStockSummary />);

    expect(screen.queryByText('Healthy Branch')).not.toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Critical Branch');
    expect(items[1]).toHaveTextContent('Low Branch');
    expect(screen.getByText('View Inventory').closest('a')).toHaveAttribute('href', '/admin/inventory');
  });

  it('filters to a single branch when branchId is given', () => {
    mockUseAdminInventoryRollup.mockReturnValue({
      data: { branches: [branch({ branch_id: 'b1', branch_name: 'Branch One', low_stock_count: 1 }), branch({ branch_id: 'b2', branch_name: 'Branch Two', low_stock_count: 4 })] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<DashboardLowStockSummary branchId="b1" />);

    expect(screen.getByText('Branch One')).toBeInTheDocument();
    expect(screen.queryByText('Branch Two')).not.toBeInTheDocument();
  });

  it('renders an empty state when no branch has low stock', () => {
    mockUseAdminInventoryRollup.mockReturnValue({ data: { branches: [branch({})] }, isLoading: false, isError: false, refetch: vi.fn() });
    render(<DashboardLowStockSummary />);
    expect(screen.getByText('No low stock items')).toBeInTheDocument();
  });

  it('renders an error state with retry', () => {
    mockUseAdminInventoryRollup.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<DashboardLowStockSummary />);
    expect(screen.getByText(/something went wrong|error/i)).toBeInTheDocument();
  });
});
