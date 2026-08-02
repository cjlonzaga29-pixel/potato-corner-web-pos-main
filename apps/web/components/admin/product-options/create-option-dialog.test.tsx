import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryCategoryResponse, InventoryItemResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { CreateOptionDialog } from './create-option-dialog';

const { mockUseCreateProductOption, mockUseInventoryCategories, mockUseInventoryItems, mockUseUnitsOfMeasure } = vi.hoisted(() => ({
  mockUseCreateProductOption: vi.fn(),
  mockUseInventoryCategories: vi.fn(),
  mockUseInventoryItems: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useCreateProductOption: mockUseCreateProductOption,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryCategories: mockUseInventoryCategories,
  useInventoryItems: mockUseInventoryItems,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
}));

/** Flat, always-rendered list — same approach as edit-option-dialog.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

  function Select({ value, onValueChange, disabled, children }: { value?: string; onValueChange?: (value: string) => void; disabled?: boolean; children?: React.ReactNode }) {
    return <SelectContext.Provider value={{ value, onValueChange: disabled ? undefined : onValueChange }}>{children}</SelectContext.Provider>;
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
      <button type="button" data-selected={ctx.value === value} onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

const CATEGORIES: InventoryCategoryResponse[] = [
  { id: 'category-1', name: 'Flavor Powders', code: null, description: null, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'category-2', name: 'Packaging', code: null, description: null, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
];

const ITEM: InventoryItemResponse = {
  id: 'item-1',
  name: 'BBQ Flavor Powder',
  sku: null,
  barcode: null,
  category_id: 'category-1',
  category_name: 'Flavor Powders',
  base_unit_id: 'unit-tbsp',
  base_unit_code: 'tbsp',
  track_inventory: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const OTHER_CATEGORY_ITEM: InventoryItemResponse = {
  id: 'item-2',
  name: 'Regular Cup',
  sku: null,
  barcode: null,
  category_id: 'category-2',
  category_name: 'Packaging',
  base_unit_id: 'unit-pc',
  base_unit_code: 'pc',
  track_inventory: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const UNITS: UnitOfMeasureResponse[] = [
  { id: 'unit-tbsp', code: 'tbsp', name: 'Tablespoon', dimension: 'VOLUME', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-tsp', code: 'tsp', name: 'Teaspoon', dimension: 'VOLUME', is_base_unit: false, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-pc', code: 'pc', name: 'Piece', dimension: 'COUNT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
];

function setupMocks({ createOptionMutate = vi.fn().mockResolvedValue(undefined) } = {}) {
  mockUseCreateProductOption.mockReturnValue({ mutateAsync: createOptionMutate, isPending: false });
  mockUseInventoryCategories.mockReturnValue({ data: CATEGORIES });
  mockUseInventoryItems.mockReturnValue({ data: [ITEM, OTHER_CATEGORY_ITEM] });
  mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
  return { createOptionMutate };
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText('cheese'), { target: { value: 'bbq' } });
  fireEvent.change(screen.getByPlaceholderText('Cheese'), { target: { value: 'BBQ' } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreateOptionDialog — Inventory Deduction', () => {
  it('shows the Inventory Deduction section', () => {
    setupMocks();
    render(<CreateOptionDialog groupId="group-1" open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Inventory Deduction')).toBeInTheDocument();
    expect(screen.getByText('Inventory Category')).toBeInTheDocument();
  });

  it('filters Inventory Item choices by the selected Inventory Category', () => {
    setupMocks();
    render(<CreateOptionDialog groupId="group-1" open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    expect(screen.getByText('BBQ Flavor Powder')).toBeInTheDocument();
    expect(screen.queryByText('Regular Cup')).not.toBeInTheDocument();
  });

  it('auto-populates the read-only Base Unit and filters Deduction Unit choices to the same dimension', () => {
    setupMocks();
    render(<CreateOptionDialog groupId="group-1" open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));

    expect(screen.getAllByText('tbsp — Tablespoon').some((el) => el.tagName === 'DIV')).toBe(true);
    expect(screen.getByText('tsp — Teaspoon')).toBeInTheDocument();
    expect(screen.queryByText('pc — Piece')).not.toBeInTheDocument();
  });

  it('sends inventory_deduction on create when a full mapping is entered', async () => {
    const { createOptionMutate } = setupMocks();
    render(<CreateOptionDialog groupId="group-1" open onOpenChange={vi.fn()} />);

    fillRequiredFields();
    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByText('tsp — Teaspoon'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Option' }));

    await waitFor(() =>
      expect(createOptionMutate).toHaveBeenCalledWith({
        code: 'bbq',
        name: 'BBQ',
        price_adjustment: 0,
        sort_order: undefined,
        is_active: true,
        inventory_deduction: { inventory_item_id: 'item-1', deduction_unit_id: 'unit-tsp', quantity_required: 0.5 },
      }),
    );
  });

  it('omits inventory_deduction on create when no deduction fields were entered', async () => {
    const { createOptionMutate } = setupMocks();
    render(<CreateOptionDialog groupId="group-1" open onOpenChange={vi.fn()} />);

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Add Option' }));

    await waitFor(() =>
      expect(createOptionMutate).toHaveBeenCalledWith({
        code: 'bbq',
        name: 'BBQ',
        price_adjustment: 0,
        sort_order: undefined,
        is_active: true,
      }),
    );
  });
});
