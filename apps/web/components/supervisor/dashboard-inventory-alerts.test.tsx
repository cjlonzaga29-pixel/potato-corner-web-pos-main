import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { InventoryAlert } from '@potato-corner/shared';
import { DashboardInventoryAlerts } from './dashboard-inventory-alerts';

afterEach(cleanup);

function alert(overrides: Partial<InventoryAlert> = {}): InventoryAlert {
  return {
    ingredient_id: 'ing-1',
    name: 'Cheddar Powder',
    unit: 'kg',
    current_stock: 2,
    threshold: 5,
    severity: 'low',
    ...overrides,
  };
}

describe('DashboardInventoryAlerts', () => {
  it('renders skeleton rows while loading', () => {
    const { container } = render(<DashboardInventoryAlerts alerts={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the healthy-stock empty state when there are no alerts', () => {
    render(<DashboardInventoryAlerts alerts={[]} isLoading={false} />);
    expect(screen.getByText('All stock levels are healthy')).toBeInTheDocument();
  });

  it('renders critical alerts before low alerts', () => {
    render(
      <DashboardInventoryAlerts
        alerts={[alert({ ingredient_id: 'ing-low', name: 'Low Item', severity: 'low' }), alert({ ingredient_id: 'ing-critical', name: 'Critical Item', severity: 'critical' })]}
        isLoading={false}
      />,
    );
    const names = screen.getAllByText(/Item/).map((el) => el.textContent);
    expect(names).toEqual(['Critical Item', 'Low Item']);
  });

  it('caps the list at 10 items and shows an "and X more" footer', () => {
    const alerts = Array.from({ length: 13 }, (_, i) => alert({ ingredient_id: `ing-${i}`, name: `Item ${i}` }));
    render(<DashboardInventoryAlerts alerts={alerts} isLoading={false} />);
    expect(screen.getAllByText(/^Item \d+$/)).toHaveLength(10);
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
  });

  it('renders a critical severity badge', () => {
    render(<DashboardInventoryAlerts alerts={[alert({ severity: 'critical' })]} isLoading={false} />);
    expect(screen.getByText('Critical').className).toContain('bg-red-100');
  });
});
