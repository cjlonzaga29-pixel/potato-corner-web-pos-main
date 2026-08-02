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

// Task 108 — editing a cart line via the Add-ons dialog calls replaceItem
// instead of removeItem+addItem, so it must both swap the line in place and
// still fold the result into another identical line when one exists.
describe('useCartStore — replaceItem (Task 108 edit cart line)', () => {
  it('replaces one line in place without touching the others', () => {
    useCartStore.setState({
      items: [
        { product_id: 'p1', product_variant_id: 'v1', quantity: 1 },
        { product_id: 'p2', product_variant_id: 'v2', quantity: 1 },
      ],
      heldOrders: [],
    });
    useCartStore.getState().replaceItem(0, [{ product_id: 'p1', product_variant_id: 'v1', quantity: 5 }]);
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ product_id: 'p1', product_variant_id: 'v1', quantity: 5 });
    expect(items[1]).toEqual({ product_id: 'p2', product_variant_id: 'v2', quantity: 1 });
  });

  it('splits one line into two when the replacement carries two distinct combinations', () => {
    useCartStore.setState({
      items: [{ product_id: 'p1', product_variant_id: 'v1', quantity: 2 }],
      heldOrders: [],
    });
    useCartStore.getState().replaceItem(0, [
      { product_id: 'p1', product_variant_id: 'v1', quantity: 1 },
      {
        product_id: 'p1',
        product_variant_id: 'v1',
        selected_options: [{ option_group_id: 'g1', option_group_name: 'Size', option_id: 'o1', option_name: 'Small', price_adjustment: 0 }],
        quantity: 1,
      },
    ]);
    expect(useCartStore.getState().items).toHaveLength(2);
  });

  it('merges the replacement into another existing line when they become identical', () => {
    useCartStore.setState({
      items: [
        {
          product_id: 'p1',
          product_variant_id: 'v1',
          selected_options: [{ option_group_id: 'g1', option_group_name: 'Size', option_id: 'o1', option_name: 'Small', price_adjustment: 0 }],
          quantity: 2,
        },
        {
          product_id: 'p1',
          product_variant_id: 'v1',
          selected_options: [{ option_group_id: 'g1', option_group_name: 'Size', option_id: 'o2', option_name: 'Large', price_adjustment: 20 }],
          quantity: 1,
        },
      ],
      heldOrders: [],
    });
    // Editing line 1 (Large x1) down to Small x1 makes it identical to line 0.
    useCartStore.getState().replaceItem(1, [
      {
        product_id: 'p1',
        product_variant_id: 'v1',
        selected_options: [{ option_group_id: 'g1', option_group_name: 'Size', option_id: 'o1', option_name: 'Small', price_adjustment: 0 }],
        quantity: 1,
      },
    ]);
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(3);
  });
});
