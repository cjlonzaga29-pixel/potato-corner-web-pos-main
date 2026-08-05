import { useCartStore } from '@/stores/cart.store';

/**
 * POS cart operations — thin wrapper over the cart Zustand store.
 *
 * Task 194A — one narrow selector per field instead of a single
 * `useCartStore()` call. The store's action functions (addItem, removeItem,
 * ...) never change identity for the lifetime of the store, so selecting
 * them individually costs nothing; the win is that a consumer of just
 * `items` (or just `heldOrders`) no longer re-renders when an unrelated
 * slice of cart state changes — e.g. a component that reads only
 * `heldOrders` won't re-render on every addItem/removeItem/updateItemQuantity
 * call against the active cart.
 */
export function useCart() {
  const items = useCartStore((state) => state.items);
  const heldOrders = useCartStore((state) => state.heldOrders);
  const addItem = useCartStore((state) => state.addItem);
  const removeItem = useCartStore((state) => state.removeItem);
  const updateItemQuantity = useCartStore((state) => state.updateItemQuantity);
  const replaceItem = useCartStore((state) => state.replaceItem);
  const clearCart = useCartStore((state) => state.clearCart);
  const holdCurrentOrder = useCartStore((state) => state.holdCurrentOrder);
  const resumeHeldOrder = useCartStore((state) => state.resumeHeldOrder);

  return {
    items,
    heldOrders,
    addItem,
    removeItem,
    updateItemQuantity,
    replaceItem,
    clearCart,
    holdCurrentOrder,
    resumeHeldOrder,
  };
}
