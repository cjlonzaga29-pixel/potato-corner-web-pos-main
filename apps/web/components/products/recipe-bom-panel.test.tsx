import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductComponentResponse } from '@potato-corner/shared';
import { RecipeBomPanel } from './recipe-bom-panel';

const { mockUseAuth, mockUseProductComponents, mockUseDeleteProductComponent, mockFormDialog } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseProductComponents: vi.fn(),
  mockUseDeleteProductComponent: vi.fn(),
  mockFormDialog: vi.fn((_props: unknown) => null),
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: mockUseAuth }));

vi.mock('@/hooks/queries/use-product-components', () => ({
  useProductComponents: mockUseProductComponents,
  useDeleteProductComponent: mockUseDeleteProductComponent,
}));

vi.mock('./recipe-component-form-dialog', () => ({
  RecipeComponentFormDialog: (props: unknown) => {
    mockFormDialog(props);
    return null;
  },
}));

const COMPONENT: ProductComponentResponse = {
  id: 'component-1',
  product_variant_id: 'variant-1',
  inventory_item_id: 'item-1',
  inventory_item_name: 'Cheese Powder',
  inventory_item_sku: 'CHZ-1',
  base_unit_code: 'kg',
  quantity_required: 2,
  is_active: true,
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function renderPanel() {
  render(<RecipeBomPanel productVariantId="variant-1" variantLabel="Regular (Small)" />);
}

beforeEach(() => {
  mockUseDeleteProductComponent.mockReturnValue({ mutateAsync: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RecipeBomPanel — loading/empty/error states', () => {
  it('shows a loading indicator while the query is in flight', () => {
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });

    const { container } = render(<RecipeBomPanel productVariantId="variant-1" variantLabel="Regular (Small)" />);

    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows an error state with retry on failure', () => {
    const refetch = vi.fn();
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });

    renderPanel();

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no components', () => {
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });

    renderPanel();

    expect(screen.getByText('No recipe components yet')).toBeInTheDocument();
  });
});

describe('RecipeBomPanel — Admin write access', () => {
  it('shows Add Component, Edit, and Remove controls for Admin', () => {
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: [COMPONENT], isLoading: false, isError: false, refetch: vi.fn() });

    renderPanel();

    expect(screen.getByText('Add Component')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('shows the component name, quantity, unit, and active status', () => {
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: [COMPONENT], isLoading: false, isError: false, refetch: vi.fn() });

    renderPanel();

    expect(screen.getByText('Cheese Powder')).toBeInTheDocument();
    expect(screen.getByText('2 kg required')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('opens a confirmation dialog before removing a component, and only calls delete after confirming', () => {
    const mutateAsync = vi.fn();
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: [COMPONENT], isLoading: false, isError: false, refetch: vi.fn() });
    mockUseDeleteProductComponent.mockReturnValue({ mutateAsync });

    renderPanel();
    fireEvent.click(screen.getByText('Remove'));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('Remove Cheese Powder?')).toBeInTheDocument();

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    const confirmButton = removeButtons.at(-1);
    if (!confirmButton) throw new Error('Confirm dialog Remove button not found');
    fireEvent.click(confirmButton);
    expect(mutateAsync).toHaveBeenCalledWith('component-1');
  });

  it('opens the form dialog in edit mode with the selected component', () => {
    mockUseAuth.mockReturnValue({ isAdmin: () => true });
    mockUseProductComponents.mockReturnValue({ data: [COMPONENT], isLoading: false, isError: false, refetch: vi.fn() });

    renderPanel();
    fireEvent.click(screen.getByText('Edit'));

    const lastCall = mockFormDialog.mock.calls.at(-1);
    if (!lastCall) throw new Error('RecipeComponentFormDialog was not called');
    expect((lastCall[0] as { editingComponent?: ProductComponentResponse; open: boolean }).editingComponent).toBe(COMPONENT);
    expect((lastCall[0] as { open: boolean }).open).toBe(true);
  });
});

describe('RecipeBomPanel — Supervisor read-only access', () => {
  it('does not show Add Component, Edit, or Remove controls for a non-Admin (Supervisor) caller', () => {
    mockUseAuth.mockReturnValue({ isAdmin: () => false });
    mockUseProductComponents.mockReturnValue({ data: [COMPONENT], isLoading: false, isError: false, refetch: vi.fn() });

    renderPanel();

    expect(screen.queryByText('Add Component')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
    expect(screen.getByText('Cheese Powder')).toBeInTheDocument();
  });
});
