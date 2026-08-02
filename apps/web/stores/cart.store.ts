import { create } from 'zustand';
import type { CartItem } from '@potato-corner/shared';

// CR-008 Product Option selection (Task 21) — frontend cart state. Not part
// of the shared cartItemSchema/CreateTransactionInput contract: only
// option_id is forwarded to checkout (as selected_option_ids, Task 26); the
// display metadata here (names, price_adjustment) stays frontend-only.
export interface PosCartSelectedOption {
  option_group_id: string;
  option_group_name: string;
  option_id: string;
  option_name: string;
  price_adjustment: number;
}

export type PosCartItem = CartItem & { selected_options?: PosCartSelectedOption[] };

function sameSelectedFlavors(a: CartItem['selected_flavors'], b: CartItem['selected_flavors']): boolean {
  const aList = a ?? [];
  const bList = b ?? [];
  if (aList.length !== bList.length) return false;
  const sortedA = [...aList].sort((x, y) => x.slot_index - y.slot_index);
  const sortedB = [...bList].sort((x, y) => x.slot_index - y.slot_index);
  return sortedA.every(
    (slot, i) =>
      slot.slot_index === sortedB[i]?.slot_index &&
      slot.snack_product_variant_id === sortedB[i]?.snack_product_variant_id &&
      slot.flavor_id === sortedB[i]?.flavor_id,
  );
}

function sameSelectedOptions(a: PosCartSelectedOption[] | undefined, b: PosCartSelectedOption[] | undefined): boolean {
  const aList = a ?? [];
  const bList = b ?? [];
  if (aList.length !== bList.length) return false;
  const sortedA = [...aList].map((o) => o.option_id).sort();
  const sortedB = [...bList].map((o) => o.option_id).sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

interface HeldOrder {
  id: string;
  items: PosCartItem[];
  heldAt: number;
}

interface CartState {
  items: PosCartItem[];
  heldOrders: HeldOrder[];
  addItem: (item: PosCartItem) => void;
  removeItem: (index: number) => void;
  updateItemQuantity: (index: number, quantity: number) => void;
  replaceItem: (index: number, replacements: PosCartItem[]) => void;
  clearCart: () => void;
  holdCurrentOrder: () => void;
  resumeHeldOrder: (id: string) => void;
}

/**
 * POS cart is browser-only state, not server data — owned by Zustand, never
 * TanStack Query. Held orders: max 3, 15-minute expiry (enforced by the
 * component/hook that reads heldAt, not this store).
 */
export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  heldOrders: [],
  // Tapping the same variant+flavor again increments its existing line
  // instead of adding a duplicate row.
  addItem: (item) =>
    set((state) => {
      const existing = state.items.find(
        (i) =>
          i.product_variant_id === item.product_variant_id &&
          i.flavor_id === item.flavor_id &&
          sameSelectedFlavors(i.selected_flavors, item.selected_flavors) &&
          sameSelectedOptions(i.selected_options, item.selected_options),
      );
      if (!existing) return { items: [...state.items, item] };
      return {
        items: state.items.map((i) => (i === existing ? { ...i, quantity: i.quantity + item.quantity } : i)),
      };
    }),
  removeItem: (index) =>
    set((state) => ({ items: state.items.filter((_, i) => i !== index) })),
  updateItemQuantity: (index, quantity) =>
    set((state) => {
      if (quantity <= 0) return { items: state.items.filter((_, i) => i !== index) };
      return { items: state.items.map((item, i) => (i === index ? { ...item, quantity } : item)) };
    }),
  // Task 108 — swaps ONE cart line (by index) for the line(s) produced by
  // re-editing it in the Add-ons dialog, in place, then folds any resulting
  // duplicates (e.g. an edited line now matching another existing line)
  // using the same identity check addItem uses — never leaves the stale
  // line behind, never appends a bare duplicate.
  replaceItem: (index, replacements) =>
    set((state) => {
      const spliced = [...state.items.slice(0, index), ...replacements, ...state.items.slice(index + 1)];
      const merged: PosCartItem[] = [];
      for (const item of spliced) {
        const existingIndex = merged.findIndex(
          (i) =>
            i.product_variant_id === item.product_variant_id &&
            i.flavor_id === item.flavor_id &&
            sameSelectedFlavors(i.selected_flavors, item.selected_flavors) &&
            sameSelectedOptions(i.selected_options, item.selected_options),
        );
        if (existingIndex === -1) {
          merged.push(item);
        } else {
          const existing = merged[existingIndex];
          if (existing) merged[existingIndex] = { ...existing, quantity: existing.quantity + item.quantity };
        }
      }
      return { items: merged };
    }),
  clearCart: () => set({ items: [] }),
  holdCurrentOrder: () => {
    const { items, heldOrders } = get();
    if (items.length === 0 || heldOrders.length >= 3) return;
    set({
      heldOrders: [...heldOrders, { id: crypto.randomUUID(), items, heldAt: Date.now() }],
      items: [],
    });
  },
  resumeHeldOrder: (id) => {
    const held = get().heldOrders.find((order) => order.id === id);
    if (!held) return;
    set((state) => ({
      items: held.items,
      heldOrders: state.heldOrders.filter((order) => order.id !== id),
    }));
  },
}));
