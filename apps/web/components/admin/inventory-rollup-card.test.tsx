import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { InventoryValuationReportRow } from '@potato-corner/shared';
import { InventoryRollupCard } from './inventory-rollup-card';

const { mockUseAdminInventoryRollup } = vi.hoisted(() => ({
  mockUseAdminInventoryRollup: vi.fn(),
}));

vi.mock('@/hooks/queries/use-admin-inventory-rollup', () => ({
  useAdminInventoryRollup: mockUseAdminInventoryRollup,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ingredient(overrides: Partial<InventoryValuationReportRow> = {}): InventoryValuationReportRow {
  return {
    ingredient_id: 'ing-1',
    ingredient_name: 'Cheese Powder',
    branch_id: 'branch-1',
    unit: 'kg',
    current_stock: 10,
    unit_cost: 50,
    total_value: 500,
    status: 'ok',
    ...overrides,
  };
}

describe('InventoryRollupCard', () => {
  it('renders skeleton rows when isLoading is true', () => {
    mockUseAdminInventoryRollup.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    const { container } = render(<InventoryRollupCard />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders an error state when isError is true', () => {
    mockUseAdminInventoryRollup.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<InventoryRollupCard />);
    expect(screen.getByText('Failed to load inventory rollup')).toBeInTheDocument();
  });

  it('renders an empty state when data is an empty array', () => {
    mockUseAdminInventoryRollup.mockReturnValue({
      data: { report_type: 'INVENTORY_VALUATION', computed_at: '2026-07-21T00:00:00.000Z', branch_id: null, data: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<InventoryRollupCard />);
    expect(screen.getByText('No inventory data available')).toBeInTheDocument();
  });

  it('renders total value, low stock count, and critical stock count', () => {
    mockUseAdminInventoryRollup.mockReturnValue({
      data: {
        report_type: 'INVENTORY_VALUATION',
        computed_at: '2026-07-21T00:00:00.000Z',
        branch_id: null,
        data: [
          ingredient({ ingredient_id: 'i1', total_value: 500, status: 'ok' }),
          ingredient({ ingredient_id: 'i2', total_value: 200, status: 'low' }),
          ingredient({ ingredient_id: 'i3', total_value: 100, status: 'critical' }),
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<InventoryRollupCard />);
    expect(screen.getByText('₱800.00')).toBeInTheDocument();
    expect(screen.getByText('Low Stock')).toBeInTheDocument();
    expect(screen.getByText('Critical Stock')).toBeInTheDocument();
  });

  it('sorts top at-risk ingredients: critical before low, then total_value desc', () => {
    mockUseAdminInventoryRollup.mockReturnValue({
      data: {
        report_type: 'INVENTORY_VALUATION',
        computed_at: '2026-07-21T00:00:00.000Z',
        branch_id: null,
        data: [
          ingredient({ ingredient_id: 'i1', ingredient_name: 'Ok Item', total_value: 900, status: 'ok' }),
          ingredient({ ingredient_id: 'i2', ingredient_name: 'Low High', total_value: 300, status: 'low' }),
          ingredient({ ingredient_id: 'i3', ingredient_name: 'Low Low', total_value: 100, status: 'low' }),
          ingredient({ ingredient_id: 'i4', ingredient_name: 'Critical Low', total_value: 50, status: 'critical' }),
          ingredient({ ingredient_id: 'i5', ingredient_name: 'Critical High', total_value: 400, status: 'critical' }),
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<InventoryRollupCard />);

    const names = screen.getAllByText(/^(Critical|Low) (High|Low)$/).map((el) => el.textContent);
    expect(names).toEqual(['Critical High', 'Critical Low', 'Low High', 'Low Low']);
    expect(screen.queryByText('Ok Item')).not.toBeInTheDocument();
  });
});
