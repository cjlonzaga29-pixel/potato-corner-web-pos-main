import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProductImageThumbnail } from './product-image-thumbnail';

afterEach(() => {
  cleanup();
});

describe('ProductImageThumbnail (Task 209.6 — Product List thumbnail; Task 209.x — image_url from the list response, no per-row fetch)', () => {
  it('shows a placeholder icon when the product has no image', () => {
    render(<ProductImageThumbnail hasImage={false} imageUrl={null} productName="Cheese Fries" />);

    expect(screen.getByRole('img', { name: 'Cheese Fries has no image' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Cheese Fries' })).not.toBeInTheDocument();
  });

  it('shows the placeholder icon (not a broken image) when hasImage is true but the batched signed URL is still null (e.g. signing failed)', () => {
    render(<ProductImageThumbnail hasImage imageUrl={null} productName="Cheese Fries" />);

    expect(screen.getByRole('img', { name: 'Cheese Fries has no image' })).toBeInTheDocument();
  });

  it('renders the image_url straight from the list response as a 48x48 rounded object-cover image, with no fetch of its own', () => {
    render(<ProductImageThumbnail hasImage imageUrl="https://example.com/signed.webp" productName="Cheese Fries" />);

    const img = screen.getByAltText('Cheese Fries') as HTMLImageElement;
    expect(img.src).toBe('https://example.com/signed.webp');
    expect(img.className).toContain('h-12');
    expect(img.className).toContain('w-12');
    expect(img.className).toContain('rounded-md');
    expect(img.className).toContain('object-cover');
  });
});
