import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProductImageThumbnail } from './product-image-thumbnail';

const { mockUseProductImage } = vi.hoisted(() => ({ mockUseProductImage: vi.fn() }));

vi.mock('@/hooks/queries/use-products', () => ({
  useProductImage: mockUseProductImage,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProductImageThumbnail (Task 209.6 — Product List thumbnail)', () => {
  it('shows a placeholder icon and never queries a signed URL when the product has no image', () => {
    mockUseProductImage.mockReturnValue({ data: undefined, isLoading: false });

    render(<ProductImageThumbnail productId="product-1" hasImage={false} productName="Cheese Fries" />);

    expect(screen.getByRole('img', { name: 'Cheese Fries has no image' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Cheese Fries' })).not.toBeInTheDocument();
    // enabled is gated on hasImage — the hook itself decides whether to fire,
    // but it must always be called with enabled=false so it never fetches.
    expect(mockUseProductImage).toHaveBeenCalledWith('product-1', false);
  });

  it('shows a skeleton while the signed URL is loading for a product that has an image', () => {
    mockUseProductImage.mockReturnValue({ data: undefined, isLoading: true });

    render(<ProductImageThumbnail productId="product-1" hasImage productName="Cheese Fries" />);

    expect(screen.getByTestId('product-thumbnail-skeleton')).toBeInTheDocument();
    expect(mockUseProductImage).toHaveBeenCalledWith('product-1', true);
  });

  it('renders the resolved signed URL as a 48x48 rounded object-cover image', () => {
    mockUseProductImage.mockReturnValue({ data: { image_url: 'https://example.com/signed.webp' }, isLoading: false });

    render(<ProductImageThumbnail productId="product-1" hasImage productName="Cheese Fries" />);

    const img = screen.getByAltText('Cheese Fries') as HTMLImageElement;
    expect(img.src).toBe('https://example.com/signed.webp');
    expect(img.className).toContain('h-12');
    expect(img.className).toContain('w-12');
    expect(img.className).toContain('rounded-md');
    expect(img.className).toContain('object-cover');
  });
});
