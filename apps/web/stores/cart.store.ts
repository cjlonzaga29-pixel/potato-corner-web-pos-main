import { create } from 'zustand';
import type { CartItem } from '@potato-corner/shared';

interface HeldOrder {
  id: string;
  items: CartItem[];
  heldAt: number;
}

interface CartState {
  items: CartItem[];
  heldOrders: HeldOrder[];
  addItem: (item: CartItem) => void;
  removeItem: (index: number) => void;
  updateItemQuantity: (index: number, quantity: number) => void;
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
        (i) => i.product_variant_id === item.product_variant_id && i.flavor_id === item.flavor_id,
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
