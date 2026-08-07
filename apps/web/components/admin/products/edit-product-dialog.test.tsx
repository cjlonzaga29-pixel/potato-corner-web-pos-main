import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductResponse } from '@potato-corner/shared';
import { EditProductDialog } from './edit-product-dialog';

const { mockUseUpdateProduct, mockUseProductImage, mockUseUploadProductImage, mockUseDeleteProductImage } = vi.hoisted(() => ({
  mockUseUpdateProduct: vi.fn(),
  mockUseProductImage: vi.fn(),
  mockUseUploadProductImage: vi.fn(),
  mockUseDeleteProductImage: vi.fn(),
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useUpdateProduct: mockUseUpdateProduct,
  useProductImage: mockUseProductImage,
  useUploadProductImage: mockUseUploadProductImage,
  useDeleteProductImage: mockUseDeleteProductImage,
}));

// Task 209.6 — ImageUpload's own capture/compress/validate/retry behavior is
// already covered end-to-end by image-upload.test.tsx; stubbed here to a
// single button (matching create-product-dialog.test.tsx's approach) so
// these tests stay focused on how EditProductDialog wires a staged file into
// useUploadProductImage, independent of the text form above it.
vi.mock('@/components/shared/forms/image-upload', () => ({
  ImageUpload: ({ onImageSelected, label }: { onImageSelected: (file: File, type: 'gallery_upload') => void | Promise<void>; label?: string }) => (
    <button
      type="button"
      onClick={() => {
        // Mirrors image-upload.tsx's own handleConfirm: the real component
        // catches a rejecting onImageSelected to drive its inline Retry
        // Upload UI, rather than leaving it as an unhandled rejection.
        Promise.resolve(onImageSelected(new File(['fake'], 'photo.jpg', { type: 'image/jpeg' }), 'gallery_upload')).catch(() => {});
      }}
    >
      {label ?? 'Upload Image'}
    </button>
  ),
}));

function buildProduct(overrides: Partial<ProductResponse> = {}): ProductResponse {
  return {
    id: 'product-1',
    name: 'Cheese Fries',
    description: null,
    category: 'Fries',
    category_id: null,
    category_name: null,
    has_image: false,
    status: 'active',
    status_label: 'Active',
    display_order: 0,
    is_seasonal: false,
    seasonal_start_date: null,
    seasonal_end_date: null,
    branch_exclusive: false,
    exclusive_branch_id: null,
    exclusive_branch_name: null,
    created_by: 'admin-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    variant_count: 0,
    active_variant_count: 0,
    active_branch_count: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(product: ProductResponse, imageQueryData: { image_url: string | null } | undefined = undefined, imageLoading = false) {
  const updateMutateAsync = vi.fn().mockResolvedValue(product);
  mockUseUpdateProduct.mockReturnValue({ mutateAsync: updateMutateAsync, isPending: false });
  mockUseProductImage.mockReturnValue({ data: imageQueryData, isLoading: imageLoading });
  const uploadMutateAsync = vi.fn().mockResolvedValue({ image_url: 'https://example.com/signed.webp' });
  mockUseUploadProductImage.mockReturnValue({ mutateAsync: uploadMutateAsync, isPending: false });
  const deleteMutateAsync = vi.fn().mockResolvedValue({ image_url: null });
  mockUseDeleteProductImage.mockReturnValue({ mutateAsync: deleteMutateAsync, isPending: false });

  render(<EditProductDialog open onOpenChange={vi.fn()} product={product} />);

  return { updateMutateAsync, uploadMutateAsync, deleteMutateAsync };
}

describe('EditProductDialog — Product Image (Task 209.6)', () => {
  it('shows a no-image state and the Upload Image picker when the product has no image', () => {
    setup(buildProduct({ has_image: false }));

    expect(screen.getByText('No image yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload Image' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(mockUseProductImage).toHaveBeenCalledWith('product-1', false);
  });

  it('fetches and renders the current image plus a Remove action when the product has one', () => {
    setup(buildProduct({ has_image: true }), { image_url: 'https://example.com/current.webp' });

    expect(mockUseProductImage).toHaveBeenCalledWith('product-1', true);
    const img = screen.getByAltText('Cheese Fries') as HTMLImageElement;
    expect(img.src).toBe('https://example.com/current.webp');
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace Image' })).toBeInTheDocument();
  });

  it('shows a loading skeleton instead of the image while the signed URL is being fetched', () => {
    setup(buildProduct({ has_image: true }), undefined, true);

    expect(screen.getByTestId('edit-product-image-skeleton')).toBeInTheDocument();
    expect(screen.queryByAltText('Cheese Fries')).not.toBeInTheDocument();
  });

  it('uploads a staged replacement image via useUploadProductImage, scoped to this product id (product update with image)', async () => {
    const { uploadMutateAsync } = setup(buildProduct({ has_image: true }), { image_url: 'https://example.com/current.webp' });

    fireEvent.click(screen.getByRole('button', { name: 'Replace Image' }));

    await vi.waitFor(() => expect(uploadMutateAsync).toHaveBeenCalled());
    const [args] = uploadMutateAsync.mock.calls[0] as [{ productId: string; file: File }];
    expect(args.productId).toBe('product-1');
    expect(args.file.name).toBe('photo.jpg');
  });

  it('removes the image via useDeleteProductImage, scoped to this product id', async () => {
    const { deleteMutateAsync } = setup(buildProduct({ has_image: true }), { image_url: 'https://example.com/current.webp' });

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await vi.waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith({ productId: 'product-1' }));
  });

  it('lets ImageUpload surface its own inline Retry Upload state when the upload rejects, without going through the text form', async () => {
    const { uploadMutateAsync } = setup(buildProduct({ has_image: false }));
    uploadMutateAsync.mockRejectedValueOnce(new Error('Network error'));

    fireEvent.click(screen.getByRole('button', { name: 'Upload Image' }));

    await vi.waitFor(() => expect(uploadMutateAsync).toHaveBeenCalledTimes(1));
    // The stub re-throws exactly like the real ImageUpload would; the text
    // form below is untouched by this rejection (still on its own state).
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('saving the name/description form never calls the image upload or delete mutations (product update without image)', async () => {
    const { updateMutateAsync, uploadMutateAsync, deleteMutateAsync } = setup(buildProduct({ has_image: false }));

    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: 'Updated Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await vi.waitFor(() => expect(updateMutateAsync).toHaveBeenCalled());
    expect(uploadMutateAsync).not.toHaveBeenCalled();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });
});
