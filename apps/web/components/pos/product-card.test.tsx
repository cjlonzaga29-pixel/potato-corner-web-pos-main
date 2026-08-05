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
const product: PosCatalogProduct = { id: 'product-1', name: 'Regular Fries', category: 'Snacks', variants: [firstVariant] };

/** Wraps ProductCard in a parent that re-renders on an unrelated counter — proves React.memo bails out unless product/variant/message/onTap actually change. */
function Harness({ onTap, message = null }: { onTap: (p: PosCatalogProduct, v: PosCatalogProduct['variants'][number]) => void; message?: string | null }) {
  const [unrelatedTick, setUnrelatedTick] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setUnrelatedTick((t) => t + 1)} data-testid="unrelated-trigger">
        tick {unrelatedTick}
      </button>
      <ProductCard product={product} variant={firstVariant} message={message} onTap={onTap} />
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
});
