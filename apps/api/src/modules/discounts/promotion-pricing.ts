import { computePromotionUnitDiscount, type ProductClassification, type PromotionDiscountKind } from '@potato-corner/shared';

/**
 * POS-PERF-P49 — pure promotion rules shared by the POS catalog and the
 * authoritative checkout path, so what the cashier sees and what the server
 * charges come from one implementation. No I/O here.
 * See docs/runbooks/pos-perf-p49-promotional-seasonal-products-and-discounts.md §3.
 */

export interface PromotionCandidate {
  id: string;
  name: string;
  discountKind: PromotionDiscountKind;
  discountValue: number;
  isEnabled: boolean;
  /** Asia/Manila calendar dates (YYYY-MM-DD), inclusive; null = open-ended. */
  startsOn: string | null;
  endsOn: string | null;
  version: number;
  createdAt: Date;
}

export type PromotionScheduleState = 'active' | 'scheduled' | 'expired' | 'disabled';

/** todayKey is manilaDateKey(now). YYYY-MM-DD strings compare correctly as text. */
export function promotionScheduleState(
  promotion: Pick<PromotionCandidate, 'isEnabled' | 'startsOn' | 'endsOn'>,
  todayKey: string,
): PromotionScheduleState {
  if (!promotion.isEnabled) return 'disabled';
  if (promotion.startsOn && todayKey < promotion.startsOn) return 'scheduled';
  if (promotion.endsOn && todayKey > promotion.endsOn) return 'expired';
  return 'active';
}

export const PROMOTABLE_CLASSIFICATIONS: readonly ProductClassification[] = ['promotional', 'seasonal'];

/** Statuses a promotion may never target (a product that can no longer be sold or restored to POS). */
export const NON_PROMOTABLE_STATUSES: readonly string[] = ['archived', 'discontinued'];

/**
 * Why a product can't be selected by a promotion, or null when it can.
 * Order matters only for which single reason is shown.
 */
export function productIneligibilityReason(
  product: {
    classification: ProductClassification;
    status: string;
    variants: { vatableCapAmount: number | null }[];
  },
  // POS-PERF-P50R — a cashier-selected discount is a customer discount the
  // cashier applies to a sale (e.g. a loyalty card), not a product promotion,
  // so it may name Regular products too. Automatic keeps the P49 rule.
  applicationMode: 'automatic' | 'cashier_selected' = 'automatic',
): string | null {
  if (applicationMode === 'automatic' && !PROMOTABLE_CLASSIFICATIONS.includes(product.classification)) {
    return 'Only Promotional or Seasonal products can have a promotion. Change the classification in the product editor first.';
  }
  if (NON_PROMOTABLE_STATUSES.includes(product.status)) {
    return 'Archived and discontinued products cannot have a discount.';
  }
  if (product.variants.some((variant) => variant.vatableCapAmount !== null)) {
    return 'This product has a size with a VATable price cap. How a discount splits across that cap is not defined, so discounts are not supported for it.';
  }
  return null;
}

export interface SelectedPromotion {
  promotion: PromotionCandidate;
  unitDiscount: number;
}

/**
 * Overlap rule: of the active candidates, the unit receives exactly one — the
 * largest unit discount for this base price; ties go to the earliest-created
 * promotion, then the lowest id. Never stacks. A candidate whose discount
 * rounds to 0 is ignored.
 */
export function selectPromotionForUnit(
  candidates: readonly PromotionCandidate[],
  basePrice: number,
  todayKey: string,
): SelectedPromotion | null {
  let best: SelectedPromotion | null = null;
  for (const promotion of candidates) {
    if (promotionScheduleState(promotion, todayKey) !== 'active') continue;
    const unitDiscount = computePromotionUnitDiscount(basePrice, promotion.discountKind, promotion.discountValue);
    if (unitDiscount <= 0) continue;
    if (
      best === null ||
      unitDiscount > best.unitDiscount ||
      (unitDiscount === best.unitDiscount &&
        (promotion.createdAt.getTime() < best.promotion.createdAt.getTime() ||
          (promotion.createdAt.getTime() === best.promotion.createdAt.getTime() && promotion.id < best.promotion.id)))
    ) {
      best = { promotion, unitDiscount };
    }
  }
  return best;
}
