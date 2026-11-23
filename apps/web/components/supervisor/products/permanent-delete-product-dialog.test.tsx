import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { ProductDeletionPreview } from '@potato-corner/shared';

const { mockPreview, mockDelete } = vi.hoisted(() => ({ mockPreview: vi.fn(), mockDelete: vi.fn() }));

vi.mock('@/hooks/queries/use-products', () => {
  class ProductApiError extends Error {
    constructor(
      message: string,
      public readonly code: string | undefined,
      public readonly details?: unknown,
    ) {
      super(message);
    }
  }
  return {
    ProductApiError,
    useProductDeletionPreview: mockPreview,
    useDeleteProduct: () => ({ mutateAsync: mockDelete, isPending: false }),
  };
});

import { PermanentDeleteProductDialog } from './permanent-delete-product-dialog';
import { ProductApiError } from '@/hooks/queries/use-products';

const PREVIEW: ProductDeletionPreview = {
  product: { id: 'p1', name: 'Cheese Fries' },
  branches: [
    { id: 'a', name: 'Branch A', on_pos: true },
    { id: 'b', name: 'Branch B', on_pos: false },
  ],
  size_count: 2,
  sale_count: 14,
  branch_copy_count: 1,
  is_branch_copy: false,
  has_image: true,
  can_delete: true,
  forbidden_reason: null,
  blockers: [],
};

function show(preview: Partial<ProductDeletionPreview> | null, extra: { isError?: boolean; error?: unknown } = {}) {
  mockPreview.mockReturnValue({
    data: preview ? { ...PREVIEW, ...preview } : undefined,
    isLoading: false,
    isError: extra.isError ?? false,
    error: extra.error ?? null,
    refetch: vi.fn(),
  });
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  render(<PermanentDeleteProductDialog product={{ id: 'p1', name: 'Cheese Fries' }} onOpenChange={onOpenChange} onDeleted={onDeleted} />);
  return { onOpenChange, onDeleted, dialog: screen.getByTestId('permanent-delete-product-dialog') };
}

describe('PermanentDeleteProductDialog', () => {
  beforeEach(() => {
    mockDelete.mockReset();
  });
  afterEach(cleanup);

  it('names the product, its branches and the real consequences, and says it is permanent with history kept', () => {
    const { dialog } = show({});
    expect(dialog).toHaveTextContent('Permanently delete Cheese Fries?');
    expect(dialog).toHaveTextContent('Permanent: it cannot be restored');
    expect(dialog).toHaveTextContent('Historical records remain');
    const branches = screen.getByTestId('pdel-branches');
    expect(within(branches).getByText(/Branch A/)).toHaveTextContent('Branch A (on POS)');
    expect(within(branches).getByText(/Branch B/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('2 sizes');
    expect(dialog).toHaveTextContent('All 14 past sales, receipts, refunds and reports');
    expect(dialog).toHaveTextContent('1 branch copy made from it');
    expect(dialog).toHaveTextContent('Nothing is reversed or zeroed');
  });

  it('needs DELETE typed before it deletes; Cancel changes nothing', async () => {
    const { onOpenChange, onDeleted } = show({});
    const button = screen.getByRole('button', { name: 'Permanently delete' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type DELETE to permanently delete Cheese Fries/), { target: { value: 'delete' } });
    expect(button).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDelete).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: 'DELETE' } });
    mockDelete.mockResolvedValue({ id: 'p1', name: 'Cheese Fries', deleted: true });
    fireEvent.click(button);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('explains a shared product the supervisor may not delete, with no delete button', () => {
    show({ can_delete: false, forbidden_reason: 'This product is used at branches you do not manage: Branch B is outside your assignment.' });
    expect(screen.getByTestId('pdel-forbidden')).toHaveTextContent('Branch B is outside your assignment');
    expect(screen.queryByRole('button', { name: 'Permanently delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows each blocker with its next step and offers no delete', () => {
    show({
      blockers: [
        {
          code: 'PRODUCT_DELETE_HELD_ORDERS',
          message: '1 held order at Branch A still contains this product.',
          next_action: 'Resume and complete, or cancel, those held orders on the POS first, then delete again.',
          names: ['Branch A'],
        },
      ],
    });
    expect(screen.getByTestId('pdel-blockers')).toHaveTextContent('1 held order at Branch A');
    expect(screen.getByTestId('pdel-blockers')).toHaveTextContent('Resume and complete, or cancel');
    expect(screen.queryByRole('button', { name: 'Permanently delete' })).toBeNull();
  });

  it('shows the specific blocker when one appears between opening and confirming', async () => {
    show({});
    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: 'DELETE' } });
    mockDelete.mockRejectedValue(
      new ProductApiError('blocked', 'PRODUCT_DELETE_BLOCKED', {
        blockers: [
          {
            code: 'PRODUCT_DELETE_IN_PROMOTION',
            message: 'It is part of the promotion Weekend.',
            next_action: 'Remove it from those promotions under Promotions first, then delete again.',
            names: ['Weekend'],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    expect(await screen.findByTestId('pdel-blockers')).toHaveTextContent('It is part of the promotion Weekend.');
    expect(screen.queryByTestId('pdel-error')).toBeNull();
  });

  it('treats an already-deleted product as done', async () => {
    const { onDeleted } = show({});
    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: 'DELETE' } });
    mockDelete.mockRejectedValue(new ProductApiError('gone', 'PRODUCT_ALREADY_DELETED'));
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('says so when the product is already gone on open', () => {
    show(null, { isError: true, error: new ProductApiError('gone', 'PRODUCT_ALREADY_DELETED') });
    expect(screen.getByText('This product no longer exists')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Permanently delete' })).toBeNull();
  });
});
