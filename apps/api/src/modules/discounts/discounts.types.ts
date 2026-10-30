/**
 * Discounts module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */

/** Mirrors ProductError/TransactionError — the router maps it to its declared status code. */
export class DiscountError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DiscountError';
  }
}

export interface PromotionWriteData {
  name: string;
  discountKind: 'percentage' | 'fixed_amount';
  discountValue: number;
  isEnabled: boolean;
  startsOn: string | null;
  endsOn: string | null;
  productIds: string[];
  branchIds: string[];
}

/** The promotion applied to one sale line, frozen onto TransactionItem.promotionSnapshot. */
export interface PromotionLineSnapshot {
  promotion_id: string;
  name: string;
  discount_kind: 'percentage' | 'fixed_amount';
  discount_value: number;
  version: number;
  base_price: number;
  unit_discount: number;
  quantity: number;
}

/** One line to price: the server-resolved product/size at the sale's branch. */
export interface PromotionPricingLine {
  productId: string;
  productVariantId: string;
  basePrice: number;
  vatableCapAmount: number | null;
}

export interface ResolvedLinePromotion {
  promotionId: string;
  name: string;
  discountKind: 'percentage' | 'fixed_amount';
  discountValue: number;
  version: number;
  endsOn: string | null;
  unitDiscount: number;
}
