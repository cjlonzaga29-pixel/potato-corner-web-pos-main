import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { ProductDetailResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * POS-PERF-P39 — the Edit popup's own behaviour: Close (never a Cancel that
 * pretends to undo saved sections), a discard prompt only when something is
 * actually unsaved, section forms opening inside the popup with the tabs
 * locked meanwhile, and read-only mode for a product the supervisor may not
 * edit in place. The tabs' editors are stand-ins here; each has its own tests.
 */
const { mockUseProduct, user } = vi.hoisted(() => ({
  mockUseProduct: vi.fn(),
  user: { current: { id: 'sup-1', role: 'supervisor', branchIds: ['branch-a', 'branch-b'] } },
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: user.current }) }));
vi.mock('@/hooks/queries/use-products', () => ({ useProduct: mockUseProduct }));
vi.mock('./product-details-form', () => ({
  ProductDetailsForm: ({ onDirtyChange, disabled }: { onDirtyChange: (dirty: boolean) => void; disabled: boolean }) => (
    <div>
      <input aria-label="Product Name" disabled={disabled} onChange={() => onDirtyChange(true)} />
    </div>
  ),
}));
vi.mock('@/components/products/product-sizes-panel', () => ({
  ProductSizesPanel: function SizesStandIn() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Add Size
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Add a size</DialogTitle>
          </DialogContent>
        </Dialog>
      </>
    );
  },
}));
vi.mock('@/components/products/recipe-bom-panel', () => ({ RecipeBomPanel: () => null }));
vi.mock('@/components/products/variant-choices-card', () => ({ VariantChoicesCard: () => null }));
vi.mock('./product-branch-row', () => ({ ProductBranchRow: ({ row }: { row: { branch_name: string } }) => <li>{row.branch_name}</li> }));

const { ProductEditorDialog } = await import('./product-editor-dialog');

function product(overrides: Partial<ProductDetailResponse> = {}): ProductDetailResponse {
  return {
    id: 'p1',
    name: 'Cheese Fries',
    description: null,
    category: null,
    category_id: null,
    category_name: null,
    has_image: false,
    image_url: null,
    status: 'active',
    status_label: 'Active',
    display_order: null,
    is_seasonal: false,
    seasonal_start_date: null,
    seasonal_end_date: null,
    branch_exclusive: false,
    exclusive_branch_id: null,
    exclusive_branch_name: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    variant_count: 0,
    active_variant_count: 0,
    active_branch_count: 1,
    version: 1,
    variants: [],
    branch_availability: [
      { branch_id: 'branch-a', branch_code: 'A', branch_name: 'Branch A', city: 'X', is_available: true, updated_at: null },
      { branch_id: 'branch-b', branch_code: 'B', branch_name: 'Branch B', city: 'X', is_available: false, updated_at: null },
    ],
    created_by_user: null,
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  mockUseProduct.mockReturnValue({ data: product(), isLoading: false, isError: false, refetch: vi.fn() });
  user.current = { id: 'sup-1', role: 'supervisor', branchIds: ['branch-a', 'branch-b'] };
});

function tab(name: RegExp) {
  return screen.getByRole('tab', { name });
}

describe('ProductEditorDialog (POS-PERF-P39)', () => {
  it('offers the five sections and closes straight away when nothing is unsaved', async () => {
    const onClose = vi.fn();
    render(<ProductEditorDialog productId="p1" onClose={onClose} />);

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Details', 'Sizes & Prices', 'Ingredients', 'Choices', 'Branches']);
    expect(screen.getByText(/Sizes, ingredients, choices and branch changes save as you make them/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding unsaved details, and Keep editing keeps them', () => {
    const onClose = vi.fn();
    render(<ProductEditorDialog productId="p1" onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Product Name' }), { target: { value: 'x' } });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Discard your unsaved details?');

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a section form inside the popup and locks the other tabs until it closes', async () => {
    const onClose = vi.fn();
    render(<ProductEditorDialog productId="p1" initialTab="sizes" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Size' }));
    const editor = screen.getByTestId('product-editor');
    expect(await within(editor).findByRole('dialog', { name: 'Add a size' })).toBeInTheDocument();
    await waitFor(() => expect(tab(/Details/)).toBeDisabled());
    expect(tab(/Sizes/)).not.toBeDisabled();

    // Closing the popup with the form open asks first.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Close the form you have open');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is read-only, with the reason and a way to the product page, when the supervisor does not cover every branch', () => {
    user.current = { id: 'sup-2', role: 'supervisor', branchIds: ['branch-a'] };
    render(<ProductEditorDialog productId="p1" onClose={vi.fn()} />);

    expect(screen.getByText(/set up for a branch outside your assignment/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Product Name' })).toBeDisabled();
    expect(screen.getAllByRole('link', { name: /Open product page/ })[0]).toHaveAttribute('href', '/supervisor/products/p1');
  });

  it('lists every configured branch on the Branches tab', () => {
    render(<ProductEditorDialog productId="p1" initialTab="branches" onClose={vi.fn()} />);
    expect(screen.getByText('Branch A')).toBeInTheDocument();
    expect(screen.getByText('Branch B')).toBeInTheDocument();
  });
});
