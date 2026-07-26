import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RecipeOverridesView } from './recipe-overrides-view';

const {
  mockUseBranchStore,
  mockUseProducts,
  mockUseProduct,
  mockUseIngredients,
  mockUseFlavors,
  mockUseMasterRecipes,
  mockUseRecipeOverrides,
  mockUseCreateRecipeOverride,
  mockUseDeleteRecipeOverride,
  mockUseSimulateDeduction,
} = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseProducts: vi.fn(),
  mockUseProduct: vi.fn(),
  mockUseIngredients: vi.fn(),
  mockUseFlavors: vi.fn(),
  mockUseMasterRecipes: vi.fn(),
  mockUseRecipeOverrides: vi.fn(),
  mockUseCreateRecipeOverride: vi.fn(),
  mockUseDeleteRecipeOverride: vi.fn(),
  mockUseSimulateDeduction: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useProducts: mockUseProducts,
  useProduct: mockUseProduct,
}));

vi.mock('@/hooks/queries/use-inventory', () => ({
  useIngredients: mockUseIngredients,
}));

vi.mock('@/hooks/queries/use-flavors', () => ({
  useFlavors: mockUseFlavors,
}));

vi.mock('@/hooks/queries/use-recipe-overrides', () => ({
  useMasterRecipes: mockUseMasterRecipes,
  useRecipeOverrides: mockUseRecipeOverrides,
  useCreateRecipeOverride: mockUseCreateRecipeOverride,
  useDeleteRecipeOverride: mockUseDeleteRecipeOverride,
  useSimulateDeduction: mockUseSimulateDeduction,
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

function mockBranchState(activeBranchId: string | null) {
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId })
  );
}

const PRODUCT_LIST = { products: [{ id: 'product-1', name: 'Classic BBQ' }] };
const PRODUCT_DETAIL = {
  id: 'product-1',
  name: 'Classic BBQ',
  variants: [{ id: 'variant-1', name: 'Regular', size_label: 'Reg' }],
};

const MASTER_RECIPE_ROWS = [{ id: 'recipe-1', ingredient_name: 'Cheddar Powder', quantity: 10, unit: 'g', flavor_name: null }];
const OVERRIDE_ROWS = [{ id: 'override-1', ingredient_name: 'BBQ Powder', quantity: 5, unit: 'g', flavor_name: null }];

function selectVariant() {
  fireEvent.click(screen.getByText('Regular (Reg)'));
}

beforeEach(() => {
  mockBranchState('branch-1');
  mockUseProducts.mockReturnValue({ data: PRODUCT_LIST });
  mockUseProduct.mockReturnValue({ data: PRODUCT_DETAIL });
  mockUseIngredients.mockReturnValue({ data: [] });
  mockUseFlavors.mockReturnValue({ data: { flavors: [] } });
  mockUseMasterRecipes.mockReturnValue({ data: MASTER_RECIPE_ROWS });
  mockUseRecipeOverrides.mockReturnValue({ data: OVERRIDE_ROWS });
  mockUseCreateRecipeOverride.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseDeleteRecipeOverride.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseSimulateDeduction.mockReturnValue({ mutateAsync: vi.fn(), isPending: false, data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RecipeOverridesView', () => {
  describe('branch context', () => {
    it('prompts for an active branch instead of rendering overrides when none is selected', () => {
      mockBranchState(null);
      render(<RecipeOverridesView />);
      expect(screen.getByText(/select an active branch to manage recipe overrides/i)).toBeInTheDocument();
    });
  });

  describe('legacy disclaimer', () => {
    it('states recipe/branch override configuration is legacy and unused by active POS inventory deduction', () => {
      render(<RecipeOverridesView />);
      expect(
        screen.getByText(
          /legacy recipe overrides are not currently used by pos inventory deduction\. active stock deduction is driven by\s*productinventory mappings/i
        )
      ).toBeInTheDocument();
    });
  });

  describe('recipe list and override rendering', () => {
    it('renders master recipe rows once a variant is selected', () => {
      render(<RecipeOverridesView />);
      selectVariant();
      expect(screen.getByText(/cheddar powder — 10 g \(base\)/i)).toBeInTheDocument();
    });

    it('renders existing branch override rows with a delete action', () => {
      render(<RecipeOverridesView />);
      selectVariant();
      expect(screen.getByText(/bbq powder — 5 g \(base\)/i)).toBeInTheDocument();
    });

    it('shows the create action for adding a new override', () => {
      render(<RecipeOverridesView />);
      selectVariant();
      expect(screen.getByRole('button', { name: /add override/i })).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('does not claim POS deduction falls back to or uses the master Recipe when there are no overrides', () => {
      mockUseRecipeOverrides.mockReturnValue({ data: [] });
      render(<RecipeOverridesView />);
      selectVariant();

      const emptyMessage = screen.getByText(/no overrides yet/i);
      expect(emptyMessage).toBeInTheDocument();
      expect(emptyMessage.textContent).not.toMatch(/fallback|falls back|uses the master recipe|default(s)? to the master recipe/i);
      expect(emptyMessage.textContent).toMatch(/legacy recipe overrides are not currently used by pos inventory deduction/i);
    });
  });

  describe('legacy simulation', () => {
    it('labels the simulation feature as legacy', () => {
      render(<RecipeOverridesView />);
      selectVariant();
      expect(screen.getByText(/legacy recipe simulation/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /run legacy simulation/i })).toBeInTheDocument();
      expect(screen.getByText(/legacy simulation only — does not reflect active pos inventory deduction/i)).toBeInTheDocument();
    });

    it('does not claim active branch overrides are applied to POS deduction anywhere in the simulation UI', () => {
      render(<RecipeOverridesView />);
      selectVariant();

      const simulationBlock = screen.getByText(/legacy recipe simulation/i).closest('div.rounded-md');
      expect(simulationBlock).not.toBeNull();
      expect(simulationBlock?.textContent).not.toMatch(/applied to (active )?pos (inventory )?deduction/i);
    });

    it('keeps the simulation handler callable and invokes the mutation with the selected variant', async () => {
      const mutateAsync = vi.fn().mockResolvedValue(undefined);
      mockUseSimulateDeduction.mockReturnValue({ mutateAsync, isPending: false, data: undefined });

      render(<RecipeOverridesView />);
      selectVariant();
      fireEvent.click(screen.getByRole('button', { name: /run legacy simulation/i }));

      expect(mutateAsync).toHaveBeenCalledWith({
        product_variant_id: 'variant-1',
        flavor_id: undefined,
        quantity_sold: 1,
        branch_id: 'branch-1',
      });
    });

    it('disables the simulation action while a simulation is pending (loading state)', () => {
      mockUseSimulateDeduction.mockReturnValue({ mutateAsync: vi.fn(), isPending: true, data: undefined });
      render(<RecipeOverridesView />);
      selectVariant();

      expect(screen.getByRole('button', { name: /run legacy simulation/i })).toBeDisabled();
    });
  });
});
