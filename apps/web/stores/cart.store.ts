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
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
  removeItem: (index) =>
    set((state) => ({ items: state.items.filter((_, i) => i !== index) })),
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
