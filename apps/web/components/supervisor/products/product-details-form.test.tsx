import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProductDetailResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P39 — the editor's Details tab is staged: Save details sends the
 * version it was loaded from, a newer saved version is refused without
 * losing what was typed, Discard changes restores the saved values, and a
 * newer version refreshes the fields only while nothing is typed.
 */
const { mockUpdate, MockProductApiError } = vi.hoisted(() => {
  class MockProductApiError extends Error {
    constructor(
      message: string,
      public readonly code: string | undefined,
    ) {
      super(message);
    }
  }
  return { mockUpdate: vi.fn(), MockProductApiError };
});

vi.mock('@/hooks/queries/use-products', () => ({
  ProductApiError: MockProductApiError,
  useUpdateProduct: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useProductImage: () => ({ data: null, isLoading: false }),
  useUploadProductImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProductImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-product-categories', () => ({
  useProductCategories: () => ({ data: { categories: [{ id: 'cat-1', name: 'Fries' }] }, isLoading: false }),
}));
vi.mock('@/components/shared/forms/image-upload', () => ({ ImageUpload: () => null }));

const { ProductDetailsForm } = await import('./product-details-form');

function product(overrides: Partial<ProductDetailResponse> = {}): ProductDetailResponse {
  return {
    id: 'p1',
    name: 'Cheese Fries',
    description: 'Classic',
    category: null,
    category_id: 'cat-1',
    category_name: 'Fries',
    has_image: false,
    image_url: null,
    status: 'active',
    status_label: 'Active',
    display_order: 2,
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
    active_branch_count: 0,
    version: 4,
    variants: [],
    branch_availability: [],
    created_by_user: null,
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  mockUpdate.mockReset();
});

function nameInput() {
  return screen.getByRole('textbox', { name: /Product Name/ });
}

describe('ProductDetailsForm (POS-PERF-P39)', () => {
  it('sends nothing until Save details, then saves with the version it was loaded from', async () => {
    const onDirtyChange = vi.fn();
    mockUpdate.mockResolvedValue(product({ name: 'Cheese Fries XL', version: 5 }));
    render(<ProductDetailsForm product={product()} disabled={false} onDirtyChange={onDirtyChange} />);

    expect(screen.getByRole('button', { name: 'Save details' })).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: 'Cheese Fries XL' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(mockUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Cheese Fries XL', category_id: 'cat-1', display_order: 2, expected_version: 4 })));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByText('All details saved')).toBeInTheDocument();
  });

  it('does not report its own save as a change elsewhere while the refetch is still on its way', async () => {
    mockUpdate.mockResolvedValue(product({ name: 'Cheese Fries XL', version: 5 }));
    render(<ProductDetailsForm product={product()} disabled={false} onDirtyChange={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'Cheese Fries XL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('All details saved')).toBeInTheDocument();

    // The product prop still carries version 4; the user starts another edit.
    fireEvent.change(nameInput(), { target: { value: 'Cheese Fries XXL' } });
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByTestId('product-details-conflict')).not.toBeInTheDocument();
  });

  it('keeps typed values and explains a version conflict instead of overwriting', async () => {
    mockUpdate.mockImplementation(async () => {
      throw new MockProductApiError('Product was changed', 'PRODUCT_CONFLICT');
    });
    render(<ProductDetailsForm product={product()} disabled={false} onDirtyChange={vi.fn()} />);

    fireEvent.change(nameInput(), { target: { value: 'My Edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByTestId('product-details-conflict')).toHaveTextContent('Not saved — this product was changed elsewhere');
    expect(nameInput()).toHaveValue('My Edit');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('shows validation errors in place and sends nothing', async () => {
    render(<ProductDetailsForm product={product()} disabled={false} onDirtyChange={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('Minimum 2 characters')).toBeInTheDocument();
    expect(nameInput()).toHaveValue('X');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('Discard changes restores the saved values', async () => {
    render(<ProductDetailsForm product={product()} disabled={false} onDirtyChange={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'Typo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(nameInput()).toHaveValue('Cheese Fries'));
  });

  it('a newer saved version refreshes untouched fields, but never replaces typed ones', async () => {
    const { rerender } = render(<ProductDetailsForm product={product()} disabled={false} onDirtyChange={vi.fn()} />);
    rerender(<ProductDetailsForm product={product({ name: 'Renamed Elsewhere', version: 5 })} disabled={false} onDirtyChange={vi.fn()} />);
    await waitFor(() => expect(nameInput()).toHaveValue('Renamed Elsewhere'));

    fireEvent.change(nameInput(), { target: { value: 'Mine' } });
    rerender(<ProductDetailsForm product={product({ name: 'Renamed Again', version: 6 })} disabled={false} onDirtyChange={vi.fn()} />);
    expect(await screen.findByTestId('product-details-conflict')).toHaveTextContent('This product was changed elsewhere');
    expect(nameInput()).toHaveValue('Mine');

    fireEvent.click(screen.getByRole('button', { name: /Load latest/ }));
    await waitFor(() => expect(nameInput()).toHaveValue('Renamed Again'));
  });

  it('is read-only when the supervisor may not edit the product', () => {
    render(<ProductDetailsForm product={product()} disabled onDirtyChange={vi.fn()} />);
    expect(nameInput()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save details' })).toBeDisabled();
  });
});
