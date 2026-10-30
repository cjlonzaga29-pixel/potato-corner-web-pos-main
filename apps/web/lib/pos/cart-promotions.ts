import type { PosCatalogPromotion } from '@potato-corner/shared';

/**
 * POS-PERF-P49 — how a catalog promotion affects one cart line on this
 * terminal. The server is authoritative (it recomputes at checkout and
 * refuses a mismatch); this only decides what the cashier sees and what the
 * checkout payload acknowledges.
 *
 * - applied: online, no PWD/Senior/Employee discount chosen.
 * - not_combinable: a PWD/Senior/Employee discount is chosen (one discount per sale).
 * - offline: promotions can't be confirmed without a connection, so regular price.
 */
export type CartPromotionStatus = 'applied' | 'not_combinable' | 'offline';

export interface CartLinePromotion {
  promotionId: string;
  name: string;
  unitDiscount: number;
  status: CartPromotionStatus;
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function resolveCartLinePromotion(
  promotion: PosCatalogPromotion | null | undefined,
  context: { isOnline: boolean; transactionDiscountSelected: boolean },
): CartLinePromotion | null {
  if (!promotion || !(promotion.unit_discount > 0)) return null;
  const status: CartPromotionStatus = !context.isOnline ? 'offline' : context.transactionDiscountSelected ? 'not_combinable' : 'applied';
  return { promotionId: promotion.promotion_id, name: promotion.name, unitDiscount: promotion.unit_discount, status };
}

/** The line's discount actually charged (0 unless applied) — unit discount × quantity, same rounding as the server. */
export function cartLinePromotionDiscount(promotion: CartLinePromotion | null | undefined, quantity: number): number {
  return promotion?.status === 'applied' ? round2(promotion.unitDiscount * quantity) : 0;
}

/** The checkout acknowledgement for one line: what the cashier saw. null = "no promotion shown". */
export function cartLinePromotionAck(promotion: CartLinePromotion | null | undefined): { promotion_id: string; unit_discount: number } | null {
  return promotion?.status === 'applied' ? { promotion_id: promotion.promotionId, unit_discount: promotion.unitDiscount } : null;
}

export const PROMOTION_STATUS_NOTES: Record<Exclude<CartPromotionStatus, 'applied'>, string> = {
  not_combinable: 'not combined with PWD/Senior/Employee — regular price',
  offline: 'unavailable offline — regular price',
};

interface PromotionChangeDetail {
  product_name?: string;
  variant_name?: string;
  shown?: { unit_discount: number } | null;
  current?: { name: string; unit_discount: number } | null;
}

function peso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

/**
 * Cashier-readable lines for a PROMOTION_CHANGED refusal's details, e.g.
 * "Promo Fries (Regular): was ₱10.00 off, now no promotion". Unknown shapes
 * produce no lines; the server's own message is always shown alongside.
 */
export function describePromotionChanges(details: unknown): string[] {
  const lines = (details as { lines?: PromotionChangeDetail[] } | null | undefined)?.lines;
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const item = line.variant_name ? `${line.product_name ?? 'Item'} (${line.variant_name})` : (line.product_name ?? 'Item');
    const was = line.shown ? `${peso(line.shown.unit_discount)} off` : 'no promotion';
    const now = line.current ? `${peso(line.current.unit_discount)} off (${line.current.name})` : 'no promotion';
    return `${item}: was ${was}, now ${now}`;
  });
}
