import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryCategoryResponse, InventoryItemResponse, ProductOptionResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { EditOptionDialog } from './edit-option-dialog';

const { mockUseUpdateProductOption, mockUseInventoryCategories, mockUseInventoryItems, mockUseUnitsOfMeasure } = vi.hoisted(() => ({
  mockUseUpdateProductOption: vi.fn(),
  mockUseInventoryCategories: vi.fn(),
  mockUseInventoryItems: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useUpdateProductOption: mockUseUpdateProductOption,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryCategories: mockUseInventoryCategories,
  useInventoryItems: mockUseInventoryItems,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
}));

/** Flat, always-rendered list — same approach as recipe-component-form-dialog.test.tsx for the real Radix Select. */
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

const OPTION: ProductOptionResponse = {
  id: 'option-1',
  option_group_id: 'group-1',
  code: 'bbq',
  name: 'BBQ',
  price_adjustment: 0,
  image_url: null,
  is_active: true,
  sort_order: 1,
  inventory_deduction: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const OPTION_WITH_MAPPING: ProductOptionResponse = {
  ...OPTION,
  inventory_deduction: {
    inventory_item_id: 'item-1',
    inventory_item_name: 'BBQ Flavor Powder',
    inventory_category_id: 'category-1',
    inventory_category_name: 'Flavor Powders',
    base_unit_id: 'unit-tbsp',
    base_unit_code: 'tbsp',
    base_unit_name: 'Tablespoon',
    deduction_unit_id: 'unit-tsp',
    deduction_unit_code: 'tsp',
    deduction_unit_name: 'Teaspoon',
    quantity_required: 1.5,
  },
};

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
  { id: 'unit-ml', code: 'ml', name: 'Milliliter', dimension: 'VOLUME', is_base_unit: false, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-pc', code: 'pc', name: 'Piece', dimension: 'COUNT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-kg', code: 'kg', name: 'Kilogram', dimension: 'WEIGHT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
];

function setupMocks({ updateOptionMutate = vi.fn().mockResolvedValue(undefined) } = {}) {
  mockUseUpdateProductOption.mockReturnValue({ mutateAsync: updateOptionMutate, isPending: false });
  mockUseInventoryCategories.mockReturnValue({ data: CATEGORIES });
  mockUseInventoryItems.mockReturnValue({ data: [ITEM, OTHER_CATEGORY_ITEM] });
  mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
  return { updateOptionMutate };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditOptionDialog — Inventory Deduction', () => {
  it('shows the Inventory Deduction section', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Inventory Deduction')).toBeInTheDocument();
    expect(screen.getByText('Inventory Category')).toBeInTheDocument();
  });

  it('filters Inventory Item choices by the selected Inventory Category', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    expect(screen.getByText('BBQ Flavor Powder')).toBeInTheDocument();
    expect(screen.queryByText('Regular Cup')).not.toBeInTheDocument();
  });

  it('auto-populates the read-only Base Unit and filters Deduction Unit choices to the same dimension, excluding other-dimension units', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));

    expect(screen.getAllByText('tbsp — Tablespoon').some((el) => el.tagName === 'DIV')).toBe(true);
    expect(screen.getByText('tsp — Teaspoon')).toBeInTheDocument();
    expect(screen.getByText('ml — Milliliter')).toBeInTheDocument();
    expect(screen.queryByText('pc — Piece')).not.toBeInTheDocument();
    expect(screen.queryByText('kg — Kilogram')).not.toBeInTheDocument();
  });

  it('accepts a decimal Quantity Required', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '0.5' } });

    expect(screen.getByLabelText('Quantity Required')).toHaveValue(0.5);
  });

  it('preloads an existing mapping when the option already has one', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION_WITH_MAPPING} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('BBQ Flavor Powder')).toBeInTheDocument();
    expect(screen.getAllByText('tbsp — Tablespoon').some((el) => el.tagName === 'DIV')).toBe(true);
    expect(screen.getByLabelText('Quantity Required')).toHaveValue(1.5);
    expect(screen.getByText('tsp — Teaspoon').closest('button')).toHaveAttribute('data-selected', 'true');
  });

  it('shows empty controls when the option has no mapping', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText('Quantity Required')).toHaveValue(null);
  });

  it('sends inventory_deduction on save when a full mapping is entered', async () => {
    const { updateOptionMutate } = setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByText('tsp — Teaspoon'));
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(updateOptionMutate).toHaveBeenCalledWith({
        name: 'BBQ',
        price_adjustment: 0,
        sort_order: 1,
        is_active: true,
        inventory_deduction: { inventory_item_id: 'item-1', deduction_unit_id: 'unit-tsp', quantity_required: 0.5 },
      }),
    );
  });

  it('omits inventory_deduction on save when the option never had a mapping and nothing was entered', async () => {
    const { updateOptionMutate } = setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(updateOptionMutate).toHaveBeenCalledWith({ name: 'BBQ', price_adjustment: 0, sort_order: 1, is_active: true }),
    );
  });

  it('sends inventory_deduction: null on save when Remove is clicked on an option that had a mapping', async () => {
    const { updateOptionMutate } = setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION_WITH_MAPPING} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Remove Inventory Deduction'));
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(updateOptionMutate).toHaveBeenCalledWith({
        name: 'BBQ',
        price_adjustment: 0,
        sort_order: 1,
        is_active: true,
        inventory_deduction: null,
      }),
    );
  });
});
