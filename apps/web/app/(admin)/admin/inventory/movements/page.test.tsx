import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AdminInventoryMovementsPage from './page';

const { mockUseBranches } = vi.hoisted(() => ({ mockUseBranches: vi.fn() }));

vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: mockUseBranches }));

vi.mock('@/components/branch-ops/inventory-movements-view', () => ({
  InventoryMovementsView: ({ branchId }: { branchId?: string | null }) => <div data-testid="movements-view">branchId={branchId}</div>,
}));

/** Same jsdom-friendly native-<select> stand-in used by other Select-based form tests in this repo. */
vi.mock('@/components/ui/select', () => {
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return <option value={value}>{children}</option>;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectTrigger({ children, id }: { children?: React.ReactNode; id?: string }) {
    return <div id={id}>{children}</div>;
  }
  function SelectValue() {
    return null;
  }
  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    let options: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === SelectContent) {
        options = (child.props as { children?: React.ReactNode }).children;
      }
    });
    return (
      <select aria-label="Branch" value={value ?? ''} onChange={(e) => onValueChange?.(e.target.value)}>
        <option value="" />
        {options}
      </select>
    );
  }
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// INVENTORY AUDIT FOLLOW-UPS §3A/§7 (test #21/#22) — the Admin-reachable
// Inventory Movements screen loads and its branch filter actually drives
// which branch's movements are shown, reusing InventoryMovementsView's
// branchId override rather than a parallel implementation.
describe('AdminInventoryMovementsPage', () => {
  it('prompts to select a branch before rendering the movements view', () => {
    mockUseBranches.mockReturnValue({ data: { branches: [{ id: 'branch-1', name: 'SM North' }] } });

    render(<AdminInventoryMovementsPage />);

    expect(screen.getByText('Select a branch to view its inventory movements.')).toBeInTheDocument();
    expect(screen.queryByTestId('movements-view')).not.toBeInTheDocument();
  });

  it('renders InventoryMovementsView scoped to the selected branch once one is picked', () => {
    mockUseBranches.mockReturnValue({
      data: { branches: [{ id: 'branch-1', name: 'SM North' }, { id: 'branch-2', name: 'SM South' }] },
    });

    render(<AdminInventoryMovementsPage />);

    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-2' } });

    expect(screen.getByTestId('movements-view')).toHaveTextContent('branchId=branch-2');
  });
});
