import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseInventoryAnalytics, mockUseInventoryMovementReport } = vi.hoisted(() => ({
  mockUseInventoryAnalytics: vi.fn(),
  mockUseInventoryMovementReport: vi.fn(),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useInventoryAnalytics: mockUseInventoryAnalytics,
  useInventoryMovementReport: mockUseInventoryMovementReport,
}));

vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, prefix, isLoading }: { title: string; value: number; prefix?: string; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${value}`}</span>
    </div>
  ),
}));

vi.mock('@/components/shared/charts/area-chart', () => ({ AreaChart: () => <div>Area Chart</div> }));

vi.mock('@/components/shared/data-table/data-table', () => ({
  DataTable: ({ data }: { data: Array<{ name: string }> }) => (
    <div>
      {data.map((row) => (
        <div key={row.name}>{row.name}</div>
      ))}
    </div>
  ),
}));

import { InventoryAnalyticsPanel } from './inventory-analytics-panel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function analyticsData() {
  return {
    fast_movers: [
      { ingredient_id: 'i1', name: 'Cheese Powder', unit: 'g', total_consumed: 500, avg_daily_consumption: 16.6 },
      { ingredient_id: 'i2', name: 'Potato', unit: 'kg', total_consumed: 300, avg_daily_consumption: 10 },
    ],
    slow_movers: [],
    waste_trends: [{ date: '2026-07-01', total_waste_quantity: 2, total_waste_cost: 150 }],
    turnover_by_branch: [],
    reorder_recommendations: [],
    summary: { total_movements: 40, total_waste_cost: 150, total_consumption_cost: 5000, avg_turnover_rate: 2.5 },
  };
}

describe('InventoryAnalyticsPanel', () => {
  it('renders Inventory Cost Consumed and Waste Cost KPIs from the analytics summary', () => {
    mockUseInventoryAnalytics.mockReturnValue({ data: analyticsData(), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseInventoryMovementReport.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });

    render(<InventoryAnalyticsPanel branchId={null} />);

    expect(screen.getByText('Inventory Cost Consumed')).toBeInTheDocument();
    expect(screen.getByText('₱5000')).toBeInTheDocument();
    expect(screen.getByText('Waste Cost')).toBeInTheDocument();
    expect(screen.getByText('₱150')).toBeInTheDocument();
  });

  it('renders the Top Consumed Products table from fast_movers', () => {
    mockUseInventoryAnalytics.mockReturnValue({ data: analyticsData(), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseInventoryMovementReport.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });

    render(<InventoryAnalyticsPanel branchId={null} />);

    expect(screen.getByText('Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('Potato')).toBeInTheDocument();
  });

  it('prompts for a branch selection on Inventory Adjustments when no branch is selected', () => {
    mockUseInventoryAnalytics.mockReturnValue({ data: analyticsData(), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseInventoryMovementReport.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });

    render(<InventoryAnalyticsPanel branchId={null} />);

    expect(screen.getByText('Select a branch')).toBeInTheDocument();
  });

  it('renders adjustment type counts (excluding stock_in/sale_deduction) when a branch is selected', () => {
    mockUseInventoryAnalytics.mockReturnValue({ data: analyticsData(), isLoading: false, isError: false, refetch: vi.fn() });
    mockUseInventoryMovementReport.mockReturnValue({
      data: {
        data: [
          { movement_id: 'm1', branch_id: 'b1', branch_name: 'B1', ingredient_id: 'i1', ingredient_name: 'Cheese', unit: 'g', movement_type: 'waste', quantity_change: -5, quantity_before: 10, quantity_after: 5, recorded_by_name: null, created_at: '2026-07-01' },
          { movement_id: 'm2', branch_id: 'b1', branch_name: 'B1', ingredient_id: 'i2', ingredient_name: 'Potato', unit: 'kg', movement_type: 'stock_in', quantity_change: 10, quantity_before: 0, quantity_after: 10, recorded_by_name: null, created_at: '2026-07-01' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryAnalyticsPanel branchId="b1" />);

    expect(screen.getByText('Spoilage / Waste')).toBeInTheDocument();
    expect(screen.queryByText('Stock In')).not.toBeInTheDocument();
  });

  it('renders an error state with retry when the analytics query errors', () => {
    mockUseInventoryAnalytics.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    mockUseInventoryMovementReport.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });

    render(<InventoryAnalyticsPanel branchId={null} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
