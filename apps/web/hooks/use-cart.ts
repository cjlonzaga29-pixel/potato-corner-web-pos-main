import { useCartStore } from '@/stores/cart.store';

/** POS cart operations — thin wrapper over the cart Zustand store. */
export function useCart() {
  const { items, heldOrders, addItem, removeItem, updateItemQuantity, clearCart, holdCurrentOrder, resumeHeldOrder } =
    useCartStore();

  return { items, heldOrders, addItem, removeItem, updateItemQuantity, clearCart, holdCurrentOrder, resumeHeldOrder };
}
