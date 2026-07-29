import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { VariantCard } from './variant-card';

const { mockUseVariantOptionGroups, mockUseUnassignVariantOptionGroup, mockAssignOptionGroupDialog, mockRecipeBomPanel } = vi.hoisted(() => ({
  mockUseVariantOptionGroups: vi.fn(),
  mockUseUnassignVariantOptionGroup: vi.fn(),
  mockAssignOptionGroupDialog: vi.fn((_props: unknown) => null),
  mockRecipeBomPanel: vi.fn((_props: unknown) => null),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useVariantOptionGroups: mockUseVariantOptionGroups,
  useUnassignVariantOptionGroup: mockUseUnassignVariantOptionGroup,
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

const BRANCH_ID = 'branch-1';

function renderVariantCard(branchId: string | null = BRANCH_ID) {
  render(
    <VariantCard
      variant={VARIANT}
      branchId={branchId}
      onEditVariant={vi.fn()}
      onLinkFlavor={vi.fn()}
      onEditFlavorPricing={vi.fn()}
      onDeleteVariant={vi.fn()}
    />,
  );
}

beforeEach(() => {
  mockUseVariantOptionGroups.mockReturnValue({ data: [], isLoading: false });
  mockUseUnassignVariantOptionGroup.mockReturnValue({ mutateAsync: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VariantCard', () => {
  it('passes the variant id, label, and branchId through to RecipeBomPanel — the sole inventory-mapping UI on the card', () => {
    renderVariantCard();

    expect(mockRecipeBomPanel).toHaveBeenCalledWith(
      expect.objectContaining({ productVariantId: 'variant-1', variantLabel: 'Small (Regular)', branchId: BRANCH_ID }),
    );
  });

  it('passes a null branchId through unchanged when no branch is selected', () => {
    renderVariantCard(null);

    expect(mockRecipeBomPanel).toHaveBeenCalledWith(expect.objectContaining({ branchId: null }));
  });
});
