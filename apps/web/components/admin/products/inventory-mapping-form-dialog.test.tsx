import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProductInventoryResponse, ProductVariantResponse } from '@potato-corner/shared';
import { InventoryMappingFormDialog } from './inventory-mapping-form-dialog';

const { mockUseBranches, mockUseIngredients, mockUseCreateProductInventory, mockUseUpdateProductInventory } = vi.hoisted(() => ({
  mockUseBranches: vi.fn(),
  mockUseIngredients: vi.fn(),
  mockUseCreateProductInventory: vi.fn(),
  mockUseUpdateProductInventory: vi.fn(),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-inventory', () => ({
  useIngredients: mockUseIngredients,
}));

vi.mock('@/hooks/queries/use-product-inventory', () => ({
  useCreateProductInventory: mockUseCreateProductInventory,
  useUpdateProductInventory: mockUseUpdateProductInventory,
}));

/** Flat, always-rendered list — same approach as payment-methods-section.test.tsx for the real Radix Select. */
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

const VARIANT: ProductVariantResponse = {
  id: 'variant-1',
  product_id: 'product-1',
  name: 'Small',
  size_label: 'Regular',
  base_price: 50,
  display_order: 0,
  is_active: true,
  flavors: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const EDITING_MAPPING: ProductInventoryResponse = {
  id: 'mapping-1',
  product_variant_id: 'variant-1',
  ingredient_id: 'ingredient-1',
  ingredient_name: 'Cheese Powder',
  quantity_required: 10,
  unit: 'g',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const BRANCHES = { branches: [{ id: 'branch-1', name: 'Main Branch', code: 'MB' }], total: 1, page: 1, limit: 100 };
const INGREDIENTS = [{ id: 'ingredient-1', name: 'Cheese Powder', unit: 'g' }];

function fillQuantityAndUnit(quantity: string, unit: string) {
  fireEvent.change(screen.getByLabelText('Quantity Required'), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText('Unit'), { target: { value: unit } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryMappingFormDialog', () => {
  it('includes branch_id unchanged alongside existing fields in the create payload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<InventoryMappingFormDialog open onOpenChange={vi.fn()} variant={VARIANT} existingMappings={[]} />);

    fireEvent.click(screen.getByText('Main Branch (MB)'));
    fireEvent.click(screen.getByText('Cheese Powder'));
    fillQuantityAndUnit('2.5', 'g');
    fireEvent.click(screen.getByText('Add Item'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        branch_id: 'branch-1',
        product_variant_id: 'variant-1',
        ingredient_id: 'ingredient-1',
        quantity_required: 2.5,
        unit: 'g',
      })
    );
  });

  it('closes the dialog after a successful create (existing success behavior preserved)', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<InventoryMappingFormDialog open onOpenChange={onOpenChange} variant={VARIANT} existingMappings={[]} />);

    fireEvent.click(screen.getByText('Main Branch (MB)'));
    fireEvent.click(screen.getByText('Cheese Powder'));
    fillQuantityAndUnit('2.5', 'g');
    fireEvent.click(screen.getByText('Add Item'));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the pending state while the create mutation is in flight (existing loading behavior preserved)', () => {
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: true });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<InventoryMappingFormDialog open onOpenChange={vi.fn()} variant={VARIANT} existingMappings={[]} />);

    const submitButton = screen.getByText('Add Item').closest('button');
    expect(submitButton).toBeDisabled();
  });

  it('does not allow submission without a selected branch', () => {
    const mutateAsync = vi.fn();
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync, isPending: false });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<InventoryMappingFormDialog open onOpenChange={vi.fn()} variant={VARIANT} existingMappings={[]} />);

    fireEvent.click(screen.getByText('Cheese Powder'));
    fillQuantityAndUnit('2.5', 'g');

    const submitButton = screen.getByText('Add Item').closest('button');
    expect(submitButton).toBeDisabled();

    fireEvent.click(screen.getByText('Add Item'));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('preserves edit behavior: update payload only contains quantity_required and unit, no branch_id', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync, isPending: false });

    render(
      <InventoryMappingFormDialog
        open
        onOpenChange={vi.fn()}
        variant={VARIANT}
        existingMappings={[EDITING_MAPPING]}
        editingMapping={EDITING_MAPPING}
        editingBranchId="branch-1"
      />
    );

    fillQuantityAndUnit('15', 'ml');
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ quantity_required: 15, unit: 'ml' }));
  });

  it('passes branchId, productVariantId, and mappingId unchanged to the update hook', () => {
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(
      <InventoryMappingFormDialog
        open
        onOpenChange={vi.fn()}
        variant={VARIANT}
        existingMappings={[EDITING_MAPPING]}
        editingMapping={EDITING_MAPPING}
        editingBranchId="branch-1"
      />
    );

    expect(mockUseUpdateProductInventory).toHaveBeenCalledWith('branch-1', 'variant-1', 'mapping-1');
  });

  it('blocks update submission in edit mode when no valid branchId is available', () => {
    const mutateAsync = vi.fn();
    mockUseBranches.mockReturnValue({ data: BRANCHES, isLoading: false });
    mockUseIngredients.mockReturnValue({ data: INGREDIENTS, isLoading: false });
    mockUseCreateProductInventory.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateProductInventory.mockReturnValue({ mutateAsync, isPending: false });

    render(
      <InventoryMappingFormDialog
        open
        onOpenChange={vi.fn()}
        variant={VARIANT}
        existingMappings={[EDITING_MAPPING]}
        editingMapping={EDITING_MAPPING}
      />
    );

    fillQuantityAndUnit('15', 'ml');

    const submitButton = screen.getByText('Save Changes').closest('button');
    expect(submitButton).toBeDisabled();

    fireEvent.click(screen.getByText('Save Changes'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(mockUseUpdateProductInventory).toHaveBeenCalledWith('', 'variant-1', 'mapping-1');
  });
});
