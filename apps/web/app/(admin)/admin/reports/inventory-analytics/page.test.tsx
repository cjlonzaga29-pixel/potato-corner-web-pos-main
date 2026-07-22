import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import * as React from 'react';
import InventoryAnalyticsPage from './page';
import type { InventoryAnalyticsReport } from '@potato-corner/shared';
import type { BranchListResponse } from '@potato-corner/shared';

const { mockPush, mockUsePathname, mockUseSearchParams, mockUseInventoryAnalytics, mockUseBranches } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUsePathname: vi.fn(() => '/admin/reports/inventory-analytics'),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
  mockUseInventoryAnalytics: vi.fn(),
  mockUseBranches: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: mockUsePathname,
  useSearchParams: mockUseSearchParams,
}));

vi.mock('@/hooks/queries/use-inventory-analytics', () => ({
  useInventoryAnalytics: mockUseInventoryAnalytics,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});
  function Select({ onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) {
    return <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

function branchListResponse(overrides: Partial<BranchListResponse> = {}): BranchListResponse {
  return { branches: [{ id: 'branch-1', name: 'Main Branch' } as never], total: 1, page: 1, limit: 100, ...overrides };
}

function analyticsReport(overrides: Partial<InventoryAnalyticsReport> = {}): InventoryAnalyticsReport {
  return {
    fast_movers: [{ ingredient_id: 'ing-1', name: 'Potato', unit: 'kg', total_consumed: 50, avg_daily_consumption: 1.67 }],
    slow_movers: [{ ingredient_id: 'ing-2', name: 'Cheese Powder', unit: 'kg', total_consumed: 5, days_since_last_movement: 12 }],
    waste_trends: [{ date: '2026-07-10', total_waste_quantity: 5, total_waste_cost: 25 }],
    turnover_by_branch: [{ branch_id: 'branch-1', branch_name: 'Main Branch', turnover_rate: 0.5, total_consumed: 500, avg_inventory_value: 1000 }],
    reorder_recommendations: [{ ingredient_id: 'ing-3', name: 'Ketchup', current_stock: 5, avg_daily_consumption: 1, days_until_stockout: 5, recommended_reorder_qty: 14 }],
    summary: { total_movements: 100, total_waste_cost: 25, total_consumption_cost: 500, avg_turnover_rate: 0.5 },
    ...overrides,
  };
}

beforeEach(() => {
  // @ts-expect-error jsdom has no IntersectionObserver; stub it so KpiCard's NumberTicker doesn't throw on mount.
  window.IntersectionObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = () => [];
  };
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  mockUseBranches.mockReturnValue({ data: branchListResponse(), isLoading: false });
  mockUseInventoryAnalytics.mockReturnValue({ data: analyticsReport(), isLoading: false, isError: false, refetch: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryAnalyticsPage', () => {
  it('renders a loading skeleton initially', () => {
    mockUseInventoryAnalytics.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    const { container } = render(<InventoryAnalyticsPage />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders 4 summary KPI cards and 5 panels when data is loaded', () => {
    render(<InventoryAnalyticsPage />);
    expect(screen.getByText('Total Movements')).toBeInTheDocument();
    expect(screen.getByText('Total Waste Cost')).toBeInTheDocument();
    expect(screen.getByText('Total Consumption Cost')).toBeInTheDocument();
    expect(screen.getByText('Avg Turnover Rate')).toBeInTheDocument();

    expect(screen.getByText('Fast Movers')).toBeInTheDocument();
    expect(screen.getByText('Slow Movers')).toBeInTheDocument();
    expect(screen.getByText('Waste Trends')).toBeInTheDocument();
    expect(screen.getByText('Turnover by Branch')).toBeInTheDocument();
    expect(screen.getByText('Reorder Recommendations')).toBeInTheDocument();
  });

  it('updates the URL when the branch filter changes', () => {
    render(<InventoryAnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('branch_id=branch-1'), expect.anything());
  });

  it('updates the URL when the period filter changes', () => {
    render(<InventoryAnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('period=90d'), expect.anything());
  });

  it('renders an error state with retry when the query fails', () => {
    const refetch = vi.fn();
    mockUseInventoryAnalytics.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<InventoryAnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
