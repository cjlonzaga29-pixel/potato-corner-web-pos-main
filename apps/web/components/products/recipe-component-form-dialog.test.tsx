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
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});

  function Select({ onValueChange, children }: { onValueChange?: (value: string) => void; children?: React.ReactNode }) {
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

const UNITS: UnitOfMeasureResponse[] = [
  { id: 'unit-kg', code: 'kg', name: 'Kilogram', dimension: 'WEIGHT', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-g', code: 'g', name: 'Gram', dimension: 'WEIGHT', is_base_unit: false, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-l', code: 'l', name: 'Liter', dimension: 'VOLUME', is_base_unit: true, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  { id: 'unit-ml', code: 'ml', name: 'Milliliter', dimension: 'VOLUME', is_base_unit: false, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
];

const ITEM: InventoryItemResponse = {
  id: 'item-1',
  name: 'Cheese Powder',
  sku: null,
  barcode: null,
  category_id: null,
  category_name: null,
  base_unit_id: 'unit-kg',
  base_unit_code: 'kg',
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
});

describe('RecipeComponentFormDialog — edit mode', () => {
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
      expect(mutateAsync).toHaveBeenCalledWith({ quantity_required: 2, recipe_unit_id: 'unit-g', is_active: true }),
    );
  });
});
