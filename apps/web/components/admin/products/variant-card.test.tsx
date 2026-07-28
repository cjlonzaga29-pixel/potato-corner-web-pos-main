import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductInventoryResponse, ProductVariantResponse } from '@potato-corner/shared';
import { VariantCard } from './variant-card';

const {
  mockUseAuth,
  mockUseProductInventoryList,
  mockUseDeleteProductInventory,
  mockUseSetProductInventoryActive,
  mockInventoryMappingFormDialog,
  mockUseVariantOptionGroups,
  mockUseUnassignVariantOptionGroup,
  mockAssignOptionGroupDialog,
  mockRecipeBomPanel,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseProductInventoryList: vi.fn(),
  mockUseDeleteProductInventory: vi.fn(),
  mockUseSetProductInventoryActive: vi.fn(),
  mockInventoryMappingFormDialog: vi.fn((_props: unknown) => null),
  mockUseVariantOptionGroups: vi.fn(),
  mockUseUnassignVariantOptionGroup: vi.fn(),
  mockAssignOptionGroupDialog: vi.fn((_props: unknown) => null),
  mockRecipeBomPanel: vi.fn((_props: unknown) => null),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-product-inventory', () => ({
  useProductInventoryList: mockUseProductInventoryList,
  useDeleteProductInventory: mockUseDeleteProductInventory,
  useSetProductInventoryActive: mockUseSetProductInventoryActive,
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useVariantOptionGroups: mockUseVariantOptionGroups,
  useUnassignVariantOptionGroup: mockUseUnassignVariantOptionGroup,
}));

vi.mock('@/components/admin/products/inventory-mapping-form-dialog', () => ({
  InventoryMappingFormDialog: (props: unknown) => {
    mockInventoryMappingFormDialog(props);
    return null;
  },
}));

vi.mock('@/components/admin/products/assign-option-group-dialog', () => ({
  AssignOptionGroupDialog: (props: unknown) => {
    mockAssignOptionGroupDialog(props);
    return null;
  },
}));

vi.mock('@/components/products/recipe-bom-panel', () => ({
  RecipeBomPanel: (props: unknown) => {
    mockRecipeBomPanel(props);
    return null;
  },
}));

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
  flavor_id: null,
  flavor_name: null,
  quantity_required: 10,
  unit: 'g',
  is_active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const BRANCH_ID = 'branch-1';

function renderVariantCard() {
  render(
    <VariantCard
      variant={VARIANT}
      branchId={BRANCH_ID}
      onEditVariant={vi.fn()}
      onLinkFlavor={vi.fn()}
      onEditFlavorPricing={vi.fn()}
      onDeleteVariant={vi.fn()}
    />
  );
}

beforeEach(() => {
  mockUseVariantOptionGroups.mockReturnValue({ data: [], isLoading: false });
  mockUseUnassignVariantOptionGroup.mockReturnValue({ mutateAsync: vi.fn() });
  mockUseSetProductInventoryActive.mockReturnValue({ mutateAsync: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VariantCard', () => {
  it('passes editingBranchId to InventoryMappingFormDialog equal to its own branchId prop', () => {
    mockUseAuth.mockReturnValue({ isSupervisor: () => true });
    mockUseProductInventoryList.mockReturnValue({ data: [EDITING_MAPPING], isLoading: false });
    mockUseDeleteProductInventory.mockReturnValue({ mutateAsync: vi.fn() });

    renderVariantCard();

    expect(mockInventoryMappingFormDialog).toHaveBeenCalledWith(expect.objectContaining({ editingBranchId: BRANCH_ID }));
  });

  it('preserves existing variant and editingMapping props when opening the dialog for edit', () => {
    mockUseAuth.mockReturnValue({ isSupervisor: () => true });
    mockUseProductInventoryList.mockReturnValue({ data: [EDITING_MAPPING], isLoading: false });
    mockUseDeleteProductInventory.mockReturnValue({ mutateAsync: vi.fn() });

    renderVariantCard();

    fireEvent.click(screen.getByText('Edit'));

    const lastCall = mockInventoryMappingFormDialog.mock.calls.at(-1);
    if (!lastCall) throw new Error('InventoryMappingFormDialog was not called');
    const lastCallProps = lastCall[0] as {
      variant: ProductVariantResponse;
      editingMapping?: ProductInventoryResponse;
      editingBranchId?: string;
      open: boolean;
    };

    expect(lastCallProps.variant).toBe(VARIANT);
    expect(lastCallProps.editingMapping).toBe(EDITING_MAPPING);
    expect(lastCallProps.editingBranchId).toBe(BRANCH_ID);
    expect(lastCallProps.open).toBe(true);
  });

  it('preserves existing rendering behavior for inventory items list', () => {
    mockUseAuth.mockReturnValue({ isSupervisor: () => true });
    mockUseProductInventoryList.mockReturnValue({ data: [EDITING_MAPPING], isLoading: false });
    mockUseDeleteProductInventory.mockReturnValue({ mutateAsync: vi.fn() });

    renderVariantCard();

    expect(screen.getByText('Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('10 g')).toBeInTheDocument();
  });

  it('warns that removing a mapping can affect POS stock deduction, not that it is informational only', () => {
    mockUseAuth.mockReturnValue({ isSupervisor: () => true });
    mockUseProductInventoryList.mockReturnValue({ data: [EDITING_MAPPING], isLoading: false });
    mockUseDeleteProductInventory.mockReturnValue({ mutateAsync: vi.fn() });

    renderVariantCard();

    fireEvent.click(screen.getByText('Remove'));

    expect(screen.getByText(/permanently deletes it/i)).toBeInTheDocument();
    expect(screen.getByText(/block POS sales/i)).toBeInTheDocument();
    expect(screen.queryByText(/informational stock mapping/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/driven by Recipe/i)).not.toBeInTheDocument();
  });

  it('preserves existing delete interaction: confirming calls mutateAsync with the mapping id', async () => {
    mockUseAuth.mockReturnValue({ isSupervisor: () => true });
    mockUseProductInventoryList.mockReturnValue({ data: [EDITING_MAPPING], isLoading: false });
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDeleteProductInventory.mockReturnValue({ mutateAsync });

    renderVariantCard();

    fireEvent.click(screen.getByText('Remove'));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    const confirmButton = removeButtons.at(-1);
    if (!confirmButton) throw new Error('Confirm dialog Remove button not found');
    fireEvent.click(confirmButton);

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(EDITING_MAPPING.id));
  });
});
