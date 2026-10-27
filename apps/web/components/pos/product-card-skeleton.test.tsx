import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PosCatalogProduct } from '@potato-corner/shared';
import { ProductCard } from './product-card';
import { ProductCardSkeleton } from './product-card-skeleton';
import { POS_CARD_CLASSES } from './product-card-layout';

/**
 * POS-PERF-P39 — every tile (photo, no photo, broken photo, long text,
 * badges, unavailable) and the loading skeleton share one box: the same
 * frame, the same fixed-ratio image area and the same fixed-height text
 * rows. jsdom has no layout, so this pins the structure; the real-browser
 * geometry check is in docs/runbooks/pos-perf-p39-product-ui-consistency.md.
 */
afterEach(cleanup);

type Variant = PosCatalogProduct['variants'][number];

function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: 'v1',
    name: 'Regular',
    price: 59,
    live_ready: true,
    stock_status: 'in_stock',
    flavors: [],
    ...overrides,
  } as unknown as Variant;
}

function product(overrides: Partial<PosCatalogProduct> = {}): PosCatalogProduct {
  return { id: 'p1', name: 'Cheese Fries', category: 'Fries', has_image: false, image_url: null, variants: [variant()], ...overrides } as unknown as PosCatalogProduct;
}

function structureOf(root: HTMLElement) {
  const image = root.querySelector('.app-pos-card-image');
  const body = image?.nextElementSibling as HTMLElement | null;
  return {
    frame: POS_CARD_CLASSES.frame.split(' ').every((c) => root.classList.contains(c)),
    image: POS_CARD_CLASSES.image.split(' ').every((c) => image?.classList.contains(c)),
    rows: [...(body?.children ?? [])].map((row) => [POS_CARD_CLASSES.name, POS_CARD_CLASSES.size, POS_CARD_CLASSES.price, POS_CARD_CLASSES.message].find((cls) => row.classList.contains(cls)) ?? 'unsized'),
  };
}

const EXPECTED = { frame: true, image: true, rows: [POS_CARD_CLASSES.name, POS_CARD_CLASSES.size, POS_CARD_CLASSES.price, POS_CARD_CLASSES.message] };

describe('POS tile geometry (POS-PERF-P39)', () => {
  it.each([
    ['with a photo', product({ has_image: true, image_url: 'https://example.test/a.webp' }), variant(), null],
    ['without a photo', product(), variant(), null],
    ['with a long name and size', product({ name: 'Extra Long Cheesy Barbecue Sour Cream Mega Party Bucket Fries' }), variant({ name: 'Mega Party Bucket With Extra Dip' }), null],
    ['low stock', product(), variant({ stock_status: 'low_stock' }), null],
    ['out of stock', product(), variant({ stock_status: 'out_of_stock' }), null],
    ['not ready, with a reason', product(), variant({ live_ready: false }), 'Inventory setup incomplete for this branch and size.'],
  ])('a tile %s has the shared box', (_label, p, v, message) => {
    render(<ProductCard product={p} variant={v} message={message} onTap={vi.fn()} />);
    expect(structureOf(screen.getByRole('button'))).toEqual(EXPECTED);
  });

  it('a photo that fails to load is replaced in the same image area', () => {
    render(<ProductCard product={product({ has_image: true, image_url: 'https://example.test/broken.webp' })} variant={variant()} message={null} onTap={vi.fn()} />);
    const card = screen.getByRole('button');
    fireEvent.error(card.querySelector('img') as HTMLImageElement);
    expect(card.querySelector('img')).toBeNull();
    expect(structureOf(card)).toEqual(EXPECTED);
  });

  it('the loading skeleton has the same box as a loaded tile', () => {
    render(<ProductCardSkeleton />);
    expect(structureOf(screen.getByTestId('pos-product-card-skeleton'))).toEqual(EXPECTED);
  });

  it('keeps the full name, size and reason available when they are truncated', () => {
    const longName = 'Extra Long Cheesy Barbecue Sour Cream Mega Party Bucket Fries';
    const reason = 'Inventory setup incomplete for this branch and size.';
    render(<ProductCard product={product({ name: longName })} variant={variant({ live_ready: false, name: 'Mega Party Bucket' })} message={reason} onTap={vi.fn()} />);
    const card = screen.getByRole('button');
    expect(card).toHaveAccessibleName(`${longName}, Mega Party Bucket, ₱59.00, ${reason}`);
    expect(screen.getByText(longName)).toHaveAttribute('title', longName);
    expect(screen.getByText('Mega Party Bucket')).toHaveAttribute('title', 'Mega Party Bucket');
    expect(screen.getByText(reason)).toHaveAttribute('title', reason);
  });
});
