import { describe, it, expect, beforeEach } from 'vitest';
import { useCartStore } from './cart.store';

beforeEach(() => {
  useCartStore.setState({ items: [], heldOrders: [] });
});

describe('useCartStore — Mix & Max slot selections', () => {
  it('keeps slot-based lines with different selections separate rather than merging them', () => {
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [
        { slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-1' },
        { slot_index: 2, snack_product_variant_id: 'snack-2', flavor_id: 'flavor-2' },
      ],
      quantity: 1,
    });
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [
        { slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-2' },
        { slot_index: 2, snack_product_variant_id: 'snack-2', flavor_id: 'flavor-1' },
      ],
      quantity: 1,
    });
    expect(useCartStore.getState().items).toHaveLength(2);
  });

  it('keeps slot-based lines separate when only the chosen snack differs for an otherwise identical selection', () => {
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [{ slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-1' }],
      quantity: 1,
    });
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [{ slot_index: 1, snack_product_variant_id: 'snack-2', flavor_id: 'flavor-1' }],
      quantity: 1,
    });
    expect(useCartStore.getState().items).toHaveLength(2);
  });

  it('merges quantities for two identical slot-based selections regardless of array order', () => {
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [
        { slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-1' },
        { slot_index: 2, snack_product_variant_id: 'snack-2', flavor_id: 'flavor-2' },
      ],
      quantity: 1,
    });
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [
        { slot_index: 2, snack_product_variant_id: 'snack-2', flavor_id: 'flavor-2' },
        { slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-1' },
      ],
      quantity: 1,
    });
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(2);
  });

  it('preserves selected_flavors when the cart quantity changes', () => {
    useCartStore.getState().addItem({
      product_id: 'product-1',
      product_variant_id: 'variant-1',
      selected_flavors: [{ slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-1' }],
      quantity: 1,
    });
    useCartStore.getState().updateItemQuantity(0, 3);
    const item = useCartStore.getState().items[0];
    expect(item?.quantity).toBe(3);
    expect(item?.selected_flavors).toEqual([
      { slot_index: 1, snack_product_variant_id: 'snack-1', flavor_id: 'flavor-1' },
    ]);
  });
});
