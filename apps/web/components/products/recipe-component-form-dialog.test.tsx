import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryItemResponse, ProductComponentResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { RecipeComponentFormDialog } from './recipe-component-form-dialog';

const { mockUseInventoryItems, mockUseUnitsOfMeasure, mockUseCreateProductComponent, mockUseUpdateProductComponent } = vi.hoisted(() => ({
  mockUseInventoryItems: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
  mockUseCreateProductComponent: vi.fn(),
  mockUseUpdateProductComponent: vi.fn(),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryItems: mockUseInventoryItems,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
}));

vi.mock('@/hooks/queries/use-product-components', () => ({
  useCreateProductComponent: mockUseCreateProductComponent,
  useUpdateProductComponent: mockUseUpdateProductComponent,
}));

/** Flat, always-rendered list — same approach as inventory-mapping-form-dialog.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    return <SelectContext.Provider value={{ value, onValueChange }}>{children}</SelectContext.Provider>;
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

const UNITS: UnitOfMeasureResponse[] = [
  { id: 'unit-kg', code: 'kg', name: 'Kilogram', dimension: 'WEIGHT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-g', code: 'g', name: 'Gram', dimension: 'WEIGHT', is_base_unit: false, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-l', code: 'l', name: 'Liter', dimension: 'VOLUME', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-ml', code: 'ml', name: 'Milliliter', dimension: 'VOLUME', is_base_unit: false, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-pc', code: 'pc', name: 'Piece', dimension: 'COUNT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
];

const ITEM: InventoryItemResponse = {
  id: 'item-1',
  name: 'Cheese Powder',
  sku: null,
  barcode: null,
  category_id: 'category-1',
  category_name: 'Flavor Powders',
  base_unit_id: 'unit-kg',
  base_unit_code: 'kg',
  track_inventory: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const ITEM_2: InventoryItemResponse = {
  id: 'item-2',
  name: 'Regular Cup',
  sku: null,
  barcode: null,
  category_id: 'category-2',
  category_name: 'Packaging',
  base_unit_id: 'unit-l',
  base_unit_code: 'l',
  track_inventory: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const ITEM_PC: InventoryItemResponse = {
  id: 'item-3',
  name: 'Cup Lid',
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

const EDITING_COMPONENT: ProductComponentResponse = {
  id: 'component-1',
  product_variant_id: 'variant-1',
  inventory_item_id: 'item-1',
  inventory_item_name: 'Cheese Powder',
  inventory_item_sku: null,
  base_unit_code: 'kg',
  recipe_unit_id: 'unit-kg',
  recipe_unit_code: 'kg',
  quantity_required: 2,
  is_active: true,
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RecipeComponentFormDialog — add mode', () => {
  it('filters the unit picker to units matching the selected item base unit dimension (WEIGHT)', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cheese Powder'));

    expect(screen.getByText('kg')).toBeInTheDocument();
    expect(screen.getByText('g')).toBeInTheDocument();
    expect(screen.queryByText('l')).not.toBeInTheDocument();
    expect(screen.queryByText('ml')).not.toBeInTheDocument();
  });

  it('defaults the recipe unit to grams for a kg-based item', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cheese Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Add Component'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        product_variant_id: 'variant-1',
        inventory_item_id: 'item-1',
        quantity_required: 100,
        recipe_unit_id: 'unit-g',
      }),
    );
  });

  it('displays the selected item Inventory Category and Base Unit as read-only, and updates them when the item changes', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM, ITEM_2], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    expect(screen.queryByText('Flavor Powders')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Cheese Powder'));
    expect(screen.getByText('Flavor Powders')).toBeInTheDocument();
    expect(screen.getByText('kg — Kilogram')).toBeInTheDocument();
    // Category/base unit are plain text, not an editable control.
    expect(screen.getByText('Flavor Powders').tagName).toBe('P');

    fireEvent.click(screen.getByText('Regular Cup'));
    expect(screen.getByText('Packaging')).toBeInTheDocument();
    expect(screen.getByText('l — Liter')).toBeInTheDocument();
    expect(screen.queryByText('Flavor Powders')).not.toBeInTheDocument();
  });

  it('shows a deduction preview once quantity and unit are set', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cheese Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '10' } });

    expect(screen.getByText('Deduction Preview')).toBeInTheDocument();
    expect(screen.getByText('→ Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('10 g')).toBeInTheDocument();
    expect(screen.getByText('from Flavor Powders')).toBeInTheDocument();
    expect(screen.getByText('per item sold')).toBeInTheDocument();
  });

  it('includes the product variant label in the deduction preview', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[]}
        productVariantLabel="Regular Fries"
      />,
    );

    fireEvent.click(screen.getByText('Cheese Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '10' } });

    expect(screen.getByText('Regular Fries')).toBeInTheDocument();
    expect(screen.getByText('→ Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('10 g')).toBeInTheDocument();
    expect(screen.getByText('from Flavor Powders')).toBeInTheDocument();
  });

  it('defaults Quantity Required to 1 for a COUNT-dimension item (packaging)', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM_PC], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cup Lid'));

    expect(screen.getByLabelText('Quantity Required')).toHaveValue(1);
  });

  it('defaults Quantity Required to 0 for a WEIGHT-dimension item', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cheese Powder'));

    expect(screen.getByLabelText('Quantity Required')).toHaveValue(0);
  });

  it('defaults Quantity Required to 0 for a VOLUME-dimension item', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM_2], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Regular Cup'));

    expect(screen.getByLabelText('Quantity Required')).toHaveValue(0);
  });

  it('submits the auto-filled quantity unchanged when the admin does not edit it (COUNT item)', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM_PC], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cup Lid'));
    fireEvent.click(screen.getByText('Add Component'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        product_variant_id: 'variant-1',
        inventory_item_id: 'item-3',
        quantity_required: 1,
        recipe_unit_id: 'unit-pc',
      }),
    );
  });
});

describe('RecipeComponentFormDialog — edit mode', () => {
  it('displays the current item Inventory Category and Base Unit, and preserves the saved quantity and recipe unit', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[EDITING_COMPONENT]}
        editingComponent={EDITING_COMPONENT}
      />,
    );

    expect(screen.getByText('Flavor Powders')).toBeInTheDocument();
    expect(screen.getByText('kg — Kilogram')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity Required')).toHaveValue(2);
    expect(screen.getByText('kg').closest('button')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('Deduction Preview')).toBeInTheDocument();
    expect(screen.getByText('→ Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('2 kg')).toBeInTheDocument();
    expect(screen.getByText('from Flavor Powders')).toBeInTheDocument();
  });

  it('allows changing the recipe unit and submits it in the update payload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync, isPending: false });

    render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[EDITING_COMPONENT]}
        editingComponent={EDITING_COMPONENT}
      />,
    );

    fireEvent.click(screen.getByText('g'));
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        quantity_required: 2,
        recipe_unit_id: 'unit-g',
        is_active: true,
      }),
    );
  });
});
