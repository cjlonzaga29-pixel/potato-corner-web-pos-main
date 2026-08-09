import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ProductCard } from './product-card';
import type { PosCatalogProduct } from '@potato-corner/shared';

afterEach(() => cleanup());

function variant(overrides: Partial<PosCatalogProduct['variants'][number]> = {}): PosCatalogProduct['variants'][number] {
  return {
    id: 'variant-1',
    name: 'Regular',
    size_label: 'Regular',
    price: 59,
    vatable_cap_amount: null,
    live_ready: true,
    readiness_code: 'READY',
    missing_flavor_ids: [],
    readiness_status: 'READY',
    completion_percentage: 100,
    blocking_issues: [],
    readiness_warnings: [],
    flavors: [],
    flavor_slots: [],
    option_groups: [],
    ...overrides,
  };
}

const firstVariant = variant();
const product: PosCatalogProduct = {
  id: 'product-1',
  name: 'Regular Fries',
  category: 'Snacks',
  has_image: false,
  image_url: null,
  variants: [firstVariant],
};

/** Wraps ProductCard in a parent that re-renders on an unrelated counter — proves React.memo bails out unless product/variant/message/onTap actually change. */
function Harness({
  onTap,
  message = null,
  product: productOverride = product,
}: {
  onTap: (p: PosCatalogProduct, v: PosCatalogProduct['variants'][number]) => void;
  message?: string | null;
  product?: PosCatalogProduct;
}) {
  const [unrelatedTick, setUnrelatedTick] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setUnrelatedTick((t) => t + 1)} data-testid="unrelated-trigger">
        tick {unrelatedTick}
      </button>
      <ProductCard product={productOverride} variant={productOverride.variants[0] ?? firstVariant} message={message} onTap={onTap} />
    </div>
  );
}

describe('ProductCard', () => {
  it('does not re-render when an unrelated parent state change leaves product/variant/message/onTap unchanged', () => {
    const onTap = vi.fn();
    render(<Harness onTap={onTap} />);

    expect(screen.getByText('Regular Fries')).toBeInTheDocument();
    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');

    fireEvent.click(screen.getByTestId('unrelated-trigger'));
    fireEvent.click(screen.getByTestId('unrelated-trigger'));

    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');
  });

  it('calls onTap with the product and variant on click', () => {
    const onTap = vi.fn();
    render(<Harness onTap={onTap} />);

    fireEvent.click(screen.getByText('Regular Fries'));

    expect(onTap).toHaveBeenCalledWith(product, firstVariant);
  });

  it('shows the readiness message and marks the card not-ready when message is set', () => {
    render(<Harness onTap={vi.fn()} message="Inventory setup incomplete." />);

    expect(screen.getByText('Inventory setup incomplete.')).toBeInTheDocument();
  });

  it('re-renders when the variant prop actually changes (e.g. price update)', () => {
    const onTap = vi.fn();
    const { rerender } = render(<ProductCard product={product} variant={firstVariant} message={null} onTap={onTap} />);
    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');

    rerender(<ProductCard product={product} variant={variant({ price: 65 })} message={null} onTap={onTap} />);

    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('2');
    expect(screen.getByText('₱65.00')).toBeInTheDocument();
  });

  it('re-renders when only the product image_url changes (e.g. catalog refetch minted a new signed URL)', () => {
    const onTap = vi.fn();
    const withImage: PosCatalogProduct = { ...product, has_image: true, image_url: 'https://storage.example/a.webp' };
    const { rerender } = render(<ProductCard product={withImage} variant={firstVariant} message={null} onTap={onTap} />);
    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');

    rerender(
      <ProductCard
        product={{ ...withImage, image_url: 'https://storage.example/b.webp' }}
        variant={firstVariant}
        message={null}
        onTap={onTap}
      />,
    );

    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('2');
  });

  describe('product image', () => {
    const withImage: PosCatalogProduct = {
      ...product,
      has_image: true,
      image_url: 'https://storage.example/product-1.webp',
    };

    it('renders the image when image_url exists', () => {
      render(<Harness onTap={vi.fn()} product={withImage} />);

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'https://storage.example/product-1.webp');
    });

    it('uses "<Product Name> - <Variant>" alt text', () => {
      render(<Harness onTap={vi.fn()} product={withImage} />);

      expect(screen.getByRole('img', { name: 'Regular Fries - Regular' })).toBeInTheDocument();
    });

    it('renders the placeholder icon when the product has no image', () => {
      render(<Harness onTap={vi.fn()} product={product} />);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('falls back to the placeholder after the image fails to load', () => {
      render(<Harness onTap={vi.fn()} product={withImage} />);

      const img = screen.getByRole('img');
      fireEvent.error(img);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('remains clickable after an image load failure', () => {
      const onTap = vi.fn();
      render(<Harness onTap={onTap} product={withImage} />);

      fireEvent.error(screen.getByRole('img'));
      fireEvent.click(screen.getByText('Regular Fries'));

      expect(onTap).toHaveBeenCalledWith(withImage, withImage.variants[0]);
    });

    it('keeps product name, variant, and price visible alongside the image', () => {
      render(<Harness onTap={vi.fn()} product={withImage} />);

      expect(screen.getByText('Regular Fries')).toBeInTheDocument();
      expect(screen.getByText('Regular')).toBeInTheDocument();
      expect(screen.getByText('₱59.00')).toBeInTheDocument();
    });
  });

  // Task 209.14 — cards were long horizontal rectangles at typical grid
  // column widths (short fixed min-height vs. a much wider column). Swapping
  // to an aspect-ratio-driven box (`self-start` instead of `h-full`, so the
  // grid's row-stretch never overrides it) gives a near-square tile with the
  // image on top instead.
  it('uses a near-square box/tile presentation instead of a stretched full-height rectangle', () => {
    render(<Harness onTap={vi.fn()} />);

    const card = screen.getByRole('button', { name: /Regular Fries/ });
    expect(card).toHaveClass('app-pos-card');
    expect(card).toHaveClass('self-start');
    expect(card).not.toHaveClass('h-full');
  });

  it('marks the card unavailable and keeps it keyboard-focusable when not-ready', () => {
    const onTap = vi.fn();
    const notReady = variant({ live_ready: false });
    render(<Harness onTap={onTap} message="Inventory setup incomplete." product={{ ...product, variants: [notReady] }} />);

    const card = screen.getByRole('button', { name: /Regular Fries/ });
    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(screen.getByText('Regular Fries'), { key: 'Enter' });
    expect(onTap).toHaveBeenCalled();
  });
});
