import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductCategoryResponse } from '@potato-corner/shared';
import { CreateProductDialog } from './create-product-dialog';

const { mockUseCreateProduct, mockUseBranches, mockUseProductCategories, mockUseUploadProductImage, mockPush } = vi.hoisted(() => ({
  mockUseCreateProduct: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseProductCategories: vi.fn(),
  mockUseUploadProductImage: vi.fn(),
  mockPush: vi.fn(),
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useCreateProduct: mockUseCreateProduct,
  useUploadProductImage: mockUseUploadProductImage,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-product-categories', () => ({
  useProductCategories: mockUseProductCategories,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Task 209.6 — ImageUpload's own capture/compress/validate/retry behavior
// (camera, canvas, MIME/size validation) is already covered end-to-end by
// image-upload.test.tsx; stubbed here to a single button so these tests
// stay focused on how CreateProductDialog wires the staged file into the
// create → upload sequence.
vi.mock('@/components/shared/forms/image-upload', () => ({
  ImageUpload: ({ onImageSelected, label }: { onImageSelected: (file: File, type: 'gallery_upload') => void | Promise<void>; label?: string }) => (
    <button type="button" onClick={() => onImageSelected(new File(['fake'], 'photo.jpg', { type: 'image/jpeg' }), 'gallery_upload')}>
      {label ?? 'Product Image'}
    </button>
  ),
}));

/** Flat, always-rendered list — same approach as recipe-component-form-dialog.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

  function Select({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) {
    return <SelectContext.Provider value={{ value, onValueChange: disabled ? undefined : onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue({ placeholder }: { placeholder?: string }) {
    return <>{placeholder}</>;
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

const CATEGORIES: ProductCategoryResponse[] = [
  {
    id: 'category-1',
    code: 'fries',
    name: 'Fries',
    description: null,
    is_active: true,
    sort_order: 1,
    product_count: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'category-2',
    code: 'drinks',
    name: 'Drinks',
    description: null,
    is_active: true,
    sort_order: 2,
    product_count: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(categories: ProductCategoryResponse[] = CATEGORIES, categoriesLoading = false) {
  mockUseBranches.mockReturnValue({ data: { branches: [] }, isLoading: false });
  mockUseProductCategories.mockReturnValue({ data: { categories, total: categories.length, page: 1, limit: 100 }, isLoading: categoriesLoading });
  const mutateAsync = vi.fn().mockResolvedValue({ id: 'product-1' });
  mockUseCreateProduct.mockReturnValue({ mutateAsync, isPending: false });
  const uploadImageMutateAsync = vi.fn().mockResolvedValue({ image_url: 'https://example.com/signed.webp' });
  mockUseUploadProductImage.mockReturnValue({ mutateAsync: uploadImageMutateAsync, isPending: false });
  render(<CreateProductDialog open onOpenChange={vi.fn()} />);
  return { mutateAsync, uploadImageMutateAsync };
}

describe('CreateProductDialog — Category field', () => {
  it('renders the category field as a Select, not a free-text input', () => {
    setup();

    expect(screen.queryByPlaceholderText('Fries')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /category/i })).not.toBeInTheDocument();
  });

  it('displays active Product Categories loaded from useProductCategories', () => {
    setup();

    expect(mockUseProductCategories).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    expect(screen.getByText('Fries')).toBeInTheDocument();
    expect(screen.getByText('Drinks')).toBeInTheDocument();
  });

  it('sends the selected category as category_id in the create payload, leaving other fields unchanged', async () => {
    const { mutateAsync } = setup();

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    fireEvent.click(screen.getByText('Drinks'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const [payload] = mutateAsync.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toEqual(
      expect.objectContaining({
        name: 'Cheese Fries',
        category_id: 'category-2',
        status: 'draft',
        is_seasonal: false,
        branch_exclusive: false,
      }),
    );
    expect(payload.category).toBeUndefined();
  });

  it('shows a clear empty state and disables selection when no active categories exist', () => {
    setup([]);

    expect(screen.getByText('No active categories')).toBeInTheDocument();
    expect(screen.queryByText('Fries')).not.toBeInTheDocument();
  });

  it('does not allow arbitrary typed category text to be submitted', async () => {
    const { mutateAsync } = setup();

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    // No free-text category input exists to type into; only Select options are selectable.
    expect(screen.queryByPlaceholderText('Fries')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const [payload] = mutateAsync.mock.calls[0] as [Record<string, unknown>];
    expect(payload.category_id).toBeUndefined();
    expect(payload.category).toBeUndefined();
  });
});

describe('CreateProductDialog — Product Image (Task 209.6)', () => {
  it('creates the product without an image when none is attached', async () => {
    const { mutateAsync, uploadImageMutateAsync } = setup();

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(uploadImageMutateAsync).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/admin/products/product-1');
  });

  it('stages an image via ImageUpload and uploads it to the newly created product on submit', async () => {
    const { mutateAsync, uploadImageMutateAsync } = setup();

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    fireEvent.click(screen.getByRole('button', { name: 'Product Image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    await vi.waitFor(() => expect(uploadImageMutateAsync).toHaveBeenCalled());
    const [uploadArgs] = uploadImageMutateAsync.mock.calls[0] as [{ productId: string; file: File }];
    expect(uploadArgs.productId).toBe('product-1');
    expect(uploadArgs.file.name).toBe('photo.jpg');
    expect(mockPush).toHaveBeenCalledWith('/admin/products/product-1');
  });

  it('staging an image replaces the picker with a Remove/Replace preview instead of calling the network', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Product Image' }));

    expect(screen.queryByRole('button', { name: 'Product Image' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace Image' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove image' })).toBeInTheDocument();
  });

  it('Remove clears the staged image and brings back the picker', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Product Image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace Image' }));

    expect(screen.getByRole('button', { name: 'Product Image' })).toBeInTheDocument();
  });

  it('keeps the dialog open and offers Retry Image Upload when the post-create upload fails, without re-creating the product or losing the entered name', async () => {
    const { mutateAsync, uploadImageMutateAsync } = setup();
    uploadImageMutateAsync.mockRejectedValueOnce(new Error('Network error'));

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Cheese Fries' } });
    fireEvent.click(screen.getByRole('button', { name: 'Product Image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));

    await vi.waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
    expect(mockPush).not.toHaveBeenCalled();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    // Upload failure preserves form state — the name the cashier/admin typed is still there.
    expect(screen.getByLabelText(/product name/i)).toHaveValue('Cheese Fries');

    const retryButton = screen.getByRole('button', { name: 'Retry Image Upload' });
    uploadImageMutateAsync.mockResolvedValueOnce({ image_url: 'https://example.com/signed.webp' });
    fireEvent.click(retryButton);

    await vi.waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/products/product-1'));
    // Retry re-uses the already-created product — createProduct is never called a second time.
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(uploadImageMutateAsync).toHaveBeenCalledTimes(2);
  });
});
