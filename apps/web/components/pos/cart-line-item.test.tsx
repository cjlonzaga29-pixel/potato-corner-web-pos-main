import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CartLineItem, type CartLine } from './cart-line-item';

afterEach(() => cleanup());

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    index: 0,
    item: { product_id: 'product-1', product_variant_id: 'variant-1', quantity: 2 },
    productName: 'Regular Fries',
    variantName: 'Regular',
    flavorName: null,
    slotSelections: [],
    optionSelections: [],
    unitPrice: 59,
    quantity: 2,
    lineTotal: 118,
    vatableCapAmount: null,
    hasOptionGroups: false,
    ...overrides,
  };
}

const stableOnEdit = vi.fn();
const stableOnRemove = vi.fn();
const stableOnQuantityChange = vi.fn();

/**
 * Wraps CartLineItem in a parent that re-renders on an unrelated counter
 * (standing in for e.g. Cash Tendered typing) — proves React.memo bails out
 * unless `line`/callbacks actually change. `stableLine` and the callback
 * props are all constructed once, outside the component, so this harness's
 * own re-renders never hand CartLineItem a fresh object/function reference.
 */
function Harness({ stableLine }: { stableLine: CartLine }) {
  const [unrelatedTick, setUnrelatedTick] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setUnrelatedTick((t) => t + 1)} data-testid="unrelated-trigger">
        tick {unrelatedTick}
      </button>
      <CartLineItem line={stableLine} showDivider={false} onEdit={stableOnEdit} onRemove={stableOnRemove} onQuantityChange={stableOnQuantityChange} />
    </div>
  );
}

describe('CartLineItem', () => {
  it('does not re-render when an unrelated parent state change leaves its props unchanged', () => {
    render(<Harness stableLine={line()} />);

    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');

    fireEvent.click(screen.getByTestId('unrelated-trigger'));
    fireEvent.click(screen.getByTestId('unrelated-trigger'));

    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');
  });

  it('calls onQuantityChange with index and the new quantity on +/-', () => {
    const onQuantityChange = vi.fn();
    const testLine = line();
    render(<CartLineItem line={testLine} showDivider={false} onEdit={vi.fn()} onRemove={vi.fn()} onQuantityChange={onQuantityChange} />);

    fireEvent.click(screen.getByLabelText('Increase Regular Fries quantity'));
    expect(onQuantityChange).toHaveBeenCalledWith(0, 3);

    fireEvent.click(screen.getByLabelText('Decrease Regular Fries quantity'));
    expect(onQuantityChange).toHaveBeenCalledWith(0, 1);
  });

  it('calls onRemove with the line index', () => {
    const onRemove = vi.fn();
    render(<CartLineItem line={line({ index: 3 })} showDivider={false} onEdit={vi.fn()} onRemove={onRemove} onQuantityChange={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Remove Regular Fries from cart'));
    expect(onRemove).toHaveBeenCalledWith(3);
  });

  it('only shows the Edit button when hasOptionGroups is true, and calls onEdit with the index', () => {
    const onEdit = vi.fn();
    const { rerender } = render(
      <CartLineItem line={line({ hasOptionGroups: false })} showDivider={false} onEdit={onEdit} onRemove={vi.fn()} onQuantityChange={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();

    rerender(<CartLineItem line={line({ index: 2, hasOptionGroups: true })} showDivider={false} onEdit={onEdit} onRemove={vi.fn()} onQuantityChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(2);
  });

  it('re-renders when the line prop actually changes (e.g. quantity edited elsewhere)', () => {
    const { rerender } = render(<CartLineItem line={line()} showDivider={false} onEdit={vi.fn()} onRemove={vi.fn()} onQuantityChange={vi.fn()} />);
    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('1');

    rerender(<CartLineItem line={line({ quantity: 5, lineTotal: 295 })} showDivider={false} onEdit={vi.fn()} onRemove={vi.fn()} onQuantityChange={vi.fn()} />);

    expect(document.querySelector('[data-render-count]')?.getAttribute('data-render-count')).toBe('2');
  });
});
