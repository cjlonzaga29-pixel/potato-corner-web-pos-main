import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryCategoryResponse, InventoryItemResponse, ProductOptionAssignedVariantResponse, ProductOptionResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { EditOptionDialog } from './edit-option-dialog';

const {
  mockUseUpdateProductOption,
  mockUseProductOptionAssignedVariants,
  mockUseInventoryCategories,
  mockUseInventoryItems,
  mockUseUnitsOfMeasure,
  mockUseProductComponents,
  mockUseCreateProductComponent,
  mockUseUpdateProductComponent,
  mockUseDeleteProductComponent,
} = vi.hoisted(() => ({
  mockUseUpdateProductOption: vi.fn(),
  mockUseProductOptionAssignedVariants: vi.fn(),
  mockUseInventoryCategories: vi.fn(),
  mockUseInventoryItems: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
  mockUseProductComponents: vi.fn(),
  mockUseCreateProductComponent: vi.fn(),
  mockUseUpdateProductComponent: vi.fn(),
  mockUseDeleteProductComponent: vi.fn(),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useUpdateProductOption: mockUseUpdateProductOption,
  useProductOptionAssignedVariants: mockUseProductOptionAssignedVariants,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryCategories: mockUseInventoryCategories,
  useInventoryItems: mockUseInventoryItems,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
}));

vi.mock('@/hooks/queries/use-product-components', () => ({
  useProductComponents: mockUseProductComponents,
  useCreateProductComponent: mockUseCreateProductComponent,
  useUpdateProductComponent: mockUseUpdateProductComponent,
  useDeleteProductComponent: mockUseDeleteProductComponent,
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
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const VARIANT: ProductOptionAssignedVariantResponse = {
  product_variant_id: 'variant-1',
  variant_name: 'Regular',
  product_id: 'product-1',
  product_name: 'Fries',
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
  { id: 'unit-pc', code: 'pc', name: 'Piece', dimension: 'COUNT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
];

function setupMocks({ updateOptionMutate = vi.fn().mockResolvedValue(undefined), createComponentMutate = vi.fn().mockResolvedValue(undefined), updateComponentMutate = vi.fn().mockResolvedValue(undefined), deleteComponentMutate = vi.fn().mockResolvedValue(undefined), variants = [VARIANT], components = [] as unknown[] } = {}) {
  mockUseUpdateProductOption.mockReturnValue({ mutateAsync: updateOptionMutate, isPending: false });
  mockUseProductOptionAssignedVariants.mockReturnValue({ data: variants, isLoading: false });
  mockUseInventoryCategories.mockReturnValue({ data: CATEGORIES });
  mockUseInventoryItems.mockReturnValue({ data: [ITEM, OTHER_CATEGORY_ITEM] });
  mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS });
  mockUseProductComponents.mockReturnValue({ data: components });
  mockUseCreateProductComponent.mockReturnValue({ mutateAsync: createComponentMutate, isPending: false });
  mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: updateComponentMutate, isPending: false });
  mockUseDeleteProductComponent.mockReturnValue({ mutateAsync: deleteComponentMutate, isPending: false });
  return { updateOptionMutate, createComponentMutate, updateComponentMutate, deleteComponentMutate };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditOptionDialog — Inventory Deduction', () => {
  it('shows the Inventory Deduction section with no Manage Deduction button anywhere', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Inventory Deduction')).toBeInTheDocument();
    expect(screen.queryByText(/Manage Deduction/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not Configured/i)).not.toBeInTheDocument();
  });

  it('filters Inventory Item choices by the selected Inventory Category', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    expect(screen.getByText('BBQ Flavor Powder')).toBeInTheDocument();
    expect(screen.queryByText('Regular Cup')).not.toBeInTheDocument();
  });

  it('auto-populates the read-only Base Unit from the selected inventory item', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));

    expect(screen.getByText('tbsp — Tablespoon')).toBeInTheDocument();
  });

  it('accepts a decimal Quantity Required and shows a live Deduction Preview', () => {
    setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '0.5' } });

    expect(screen.getByText('Deduction Preview')).toBeInTheDocument();
    expect(screen.getByText('0.5 tbsp')).toBeInTheDocument();
    expect(screen.getByText('from Flavor Powders')).toBeInTheDocument();
    expect(screen.getByText('per item sold')).toBeInTheDocument();
  });

  it('saves both the option fields and a new deduction component on submit', async () => {
    const { updateOptionMutate, createComponentMutate } = setupMocks();
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Flavor Powders'));
    fireEvent.click(screen.getByText('BBQ Flavor Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(updateOptionMutate).toHaveBeenCalledWith({ name: 'BBQ', price_adjustment: 0, sort_order: 1, is_active: true }));
    await waitFor(() =>
      expect(createComponentMutate).toHaveBeenCalledWith({
        product_variant_id: 'variant-1',
        inventory_item_id: 'item-1',
        quantity_required: 0.5,
        recipe_unit_id: 'unit-tbsp',
        product_option_id: 'option-1',
      }),
    );
  });

  it('updates an existing deduction component in place when the item is unchanged', async () => {
    const existingComponent = {
      id: 'component-1',
      product_variant_id: 'variant-1',
      inventory_item_id: 'item-1',
      inventory_item_name: 'BBQ Flavor Powder',
      inventory_item_sku: null,
      base_unit_code: 'tbsp',
      recipe_unit_id: 'unit-tbsp',
      recipe_unit_code: 'tbsp',
      quantity_required: 0.5,
      is_active: true,
      product_option_id: 'option-1',
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const { updateComponentMutate } = setupMocks({ components: [existingComponent] });
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText('Quantity Required')).toHaveValue(0.5);

    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '1' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(updateComponentMutate).toHaveBeenCalledWith({ quantity_required: 1, recipe_unit_id: 'unit-tbsp' }));
  });

  it('shows guidance instead of deduction fields when the option has no assigned variants', () => {
    setupMocks({ variants: [] });
    render(<EditOptionDialog groupId="group-1" option={OPTION} open onOpenChange={vi.fn()} />);

    expect(screen.getByText(/Assign this option's group to a variant/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Quantity Required')).not.toBeInTheDocument();
  });
});
