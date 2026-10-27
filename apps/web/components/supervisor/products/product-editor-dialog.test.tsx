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
const { mockUseProduct, mockPush, user } = vi.hoisted(() => ({
  mockUseProduct: vi.fn(),
  mockPush: vi.fn(),
  user: { current: { id: 'sup-1', role: 'supervisor', branchIds: ['branch-a', 'branch-b'] } },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: user.current }) }));
vi.mock('@/hooks/queries/use-products', () => ({ useProduct: mockUseProduct }));
vi.mock('./product-details-form', () => ({
  ProductDetailsForm: ({ onDirtyChange, disabled }: { onDirtyChange: (dirty: boolean) => void; disabled: boolean }) => (
    <div>
      <input aria-label="Product Name" disabled={disabled} onChange={() => onDirtyChange(true)} />
    </div>
  ),
}));
// Like the real forms: the component that owns the typed state renders the dialog and reports it on DialogContent.
vi.mock('@/components/products/product-sizes-panel', () => ({
  ProductSizesPanel: function SizesStandIn() {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Add Size
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-sm" hasUnsavedInput={name !== ''}>
            <DialogTitle>Add a size</DialogTitle>
            <input aria-label="Size name" value={name} onChange={(event) => setName(event.target.value)} />
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

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Details', 'Sizes & Prices', 'Ingredients & Packaging', 'Flavors & Choices', 'Branches']);
    expect(screen.getByText(/each save as soon as you confirm them/)).toBeInTheDocument();
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
    expect(await within(editor).findByRole('region', { name: 'Add a size' })).toBeInTheDocument();
    await waitFor(() => expect(tab(/Details/)).toBeDisabled());
    expect(tab(/Sizes/)).not.toBeDisabled();

    // Closing the popup with the form open asks first.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Close the form you have open');
    expect(onClose).not.toHaveBeenCalled();
  });

  // POS-PERF-P41 — the section form is part of the editor, not a small dialog inside it.
  it('shows a section form inline, full width, with Back to the tab and no second dialog or corner X', async () => {
    render(<ProductEditorDialog productId="p1" initialTab="sizes" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Size' }));
    const editor = screen.getByTestId('product-editor');
    const section = await within(editor).findByRole('region', { name: 'Add a size' });

    expect(screen.getAllByRole('dialog')).toEqual([editor]);
    expect(section.className).not.toMatch(/max-w-/);
    expect(within(editor).queryByRole('button', { name: /Close this form/ })).toBeNull();
    expect(within(editor).getAllByRole('button', { name: 'Close' })).toHaveLength(1);

    fireEvent.click(within(section).getByRole('button', { name: 'Back to Sizes & Prices' }));
    await waitFor(() => expect(within(editor).queryByRole('region', { name: 'Add a size' })).toBeNull());
    await waitFor(() => expect(tab(/Details/)).not.toBeDisabled());
  });

  it('asks before Back discards a typed section form', async () => {
    render(<ProductEditorDialog productId="p1" initialTab="sizes" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Size' }));
    const section = await screen.findByRole('region', { name: 'Add a size' });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Size name' }), { target: { value: 'Jumbo' } });

    fireEvent.click(within(section).getByRole('button', { name: 'Back to Sizes & Prices' }));
    expect(within(section).getByRole('alert')).toHaveTextContent('Discard what you typed in this form?');
    fireEvent.click(within(section).getByRole('button', { name: 'Keep editing' }));
    expect(within(section).getByRole('textbox', { name: 'Size name' })).toHaveValue('Jumbo');

    fireEvent.click(within(section).getByRole('button', { name: 'Back to Sizes & Prices' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Discard and go back' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add a size' })).toBeNull());
  });

  it('asks before Open product page discards unsaved details', () => {
    const onClose = vi.fn();
    mockPush.mockClear();
    render(<ProductEditorDialog productId="p1" onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Product Name' }), { target: { value: 'x' } });

    fireEvent.click(screen.getByRole('link', { name: 'Open product page' }));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Discard your unsaved details?');
    fireEvent.click(screen.getByRole('button', { name: 'Discard and open product page' }));
    expect(mockPush).toHaveBeenCalledWith('/supervisor/products/p1');
    expect(onClose).toHaveBeenCalledTimes(1);
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
