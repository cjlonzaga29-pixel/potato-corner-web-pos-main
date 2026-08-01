import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InventoryItemResponse, ProductComponentResponse, UnitOfMeasureResponse } from '@potato-corner/shared';
import { RecipeComponentFormDialog } from './recipe-component-form-dialog';

const {
  mockUseInventoryItems,
  mockUseUnitsOfMeasure,
  mockUseCreateProductComponent,
  mockUseUpdateProductComponent,
  mockUseAllActiveProductOptions,
} = vi.hoisted(() => ({
  mockUseInventoryItems: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
  mockUseCreateProductComponent: vi.fn(),
  mockUseUpdateProductComponent: vi.fn(),
  mockUseAllActiveProductOptions: vi.fn(),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryItems: mockUseInventoryItems,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
}));

vi.mock('@/hooks/queries/use-product-components', () => ({
  useCreateProductComponent: mockUseCreateProductComponent,
  useUpdateProductComponent: mockUseUpdateProductComponent,
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useAllActiveProductOptions: mockUseAllActiveProductOptions,
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

const PRODUCT_OPTIONS = [
  { id: 'option-1', option_group_id: 'group-1', code: 'small', name: 'Small', price_adjustment: 0, image_url: null, is_active: true, sort_order: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', option_group_name: 'Size' },
  { id: 'option-2', option_group_id: 'group-1', code: 'large', name: 'Large', price_adjustment: 10, image_url: null, is_active: true, sort_order: 2, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', option_group_name: 'Size' },
];

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
  product_option_id: null,
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
    mockUseAllActiveProductOptions.mockReturnValue({ data: [], isLoading: false });
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
    mockUseAllActiveProductOptions.mockReturnValue({ data: [], isLoading: false });
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
        product_option_id: null,
      }),
    );
  });

  it('loads Product Options with Base Recipe listed first, and Create with Base Recipe sends product_option_id: null', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: PRODUCT_OPTIONS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    const optionButtons = screen.getAllByText(/Base Recipe|Size:/);
    expect(optionButtons[0]).toHaveTextContent('Base Recipe');
    expect(screen.getByText('Size: Small')).toBeInTheDocument();
    expect(screen.getByText('Size: Large')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cheese Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Add Component'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        product_variant_id: 'variant-1',
        inventory_item_id: 'item-1',
        quantity_required: 100,
        recipe_unit_id: 'unit-g',
        product_option_id: null,
      }),
    );
  });

  it('Create with a selected Product Option sends its ID in the payload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: PRODUCT_OPTIONS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<RecipeComponentFormDialog open onOpenChange={vi.fn()} productVariantId="variant-1" existingComponents={[]} />);

    fireEvent.click(screen.getByText('Cheese Powder'));
    fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Size: Large'));
    fireEvent.click(screen.getByText('Add Component'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        product_variant_id: 'variant-1',
        inventory_item_id: 'item-1',
        quantity_required: 100,
        recipe_unit_id: 'unit-g',
        product_option_id: 'option-2',
      }),
    );
  });
});

describe('RecipeComponentFormDialog — edit mode', () => {
  it('allows changing the recipe unit and submits it in the update payload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: [], isLoading: false });
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
        product_option_id: null,
      }),
    );
  });

  it('preserves the current Product Option in the update payload when left unchanged', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: PRODUCT_OPTIONS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync, isPending: false });

    const withOption: ProductComponentResponse = { ...EDITING_COMPONENT, product_option_id: 'option-2' };
    render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[withOption]}
        editingComponent={withOption}
      />,
    );

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        quantity_required: 2,
        recipe_unit_id: 'unit-kg',
        is_active: true,
        product_option_id: 'option-2',
      }),
    );
  });

  it('Edit can change to another Product Option', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: PRODUCT_OPTIONS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync, isPending: false });

    const withOption: ProductComponentResponse = { ...EDITING_COMPONENT, product_option_id: 'option-1' };
    render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[withOption]}
        editingComponent={withOption}
      />,
    );

    fireEvent.click(screen.getByText('Size: Large'));
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        quantity_required: 2,
        recipe_unit_id: 'unit-kg',
        is_active: true,
        product_option_id: 'option-2',
      }),
    );
  });

  it('Edit can clear back to Base Recipe', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: PRODUCT_OPTIONS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync, isPending: false });

    const withOption: ProductComponentResponse = { ...EDITING_COMPONENT, product_option_id: 'option-2' };
    render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[withOption]}
        editingComponent={withOption}
      />,
    );

    fireEvent.click(screen.getByText('Base Recipe'));
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        quantity_required: 2,
        recipe_unit_id: 'unit-kg',
        is_active: true,
        product_option_id: null,
      }),
    );
  });

  it('pre-selects the existing product_option_id, and null shows Base Recipe', () => {
    mockUseInventoryItems.mockReturnValue({ data: [ITEM], isLoading: false });
    mockUseUnitsOfMeasure.mockReturnValue({ data: UNITS, isLoading: false });
    mockUseAllActiveProductOptions.mockReturnValue({ data: PRODUCT_OPTIONS, isLoading: false });
    mockUseCreateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductComponent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    const { rerender } = render(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[EDITING_COMPONENT]}
        editingComponent={EDITING_COMPONENT}
      />,
    );
    expect(screen.getByText('Base Recipe').closest('button')).toHaveAttribute('data-selected', 'true');

    const withOption: ProductComponentResponse = { ...EDITING_COMPONENT, product_option_id: 'option-2' };
    rerender(
      <RecipeComponentFormDialog
        open
        onOpenChange={vi.fn()}
        productVariantId="variant-1"
        existingComponents={[withOption]}
        editingComponent={withOption}
      />,
    );
    expect(screen.getByText('Size: Large').closest('button')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('Base Recipe').closest('button')).toHaveAttribute('data-selected', 'false');
  });
});
