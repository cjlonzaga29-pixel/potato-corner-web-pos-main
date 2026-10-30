import { describe, it, expect } from 'vitest';
import { cartLinePromotionAck, cartLinePromotionDiscount, describePromotionChanges, resolveCartLinePromotion } from './cart-promotions';

const promo = { promotion_id: '11111111-1111-4111-8111-111111111111', name: 'Ten Off', discount_kind: 'fixed_amount' as const, discount_value: 10, unit_discount: 10, ends_on: null };

describe('cart promotions (P49)', () => {
  it('applies online with no transaction discount, and acknowledges exactly what is shown', () => {
    const line = resolveCartLinePromotion(promo, { isOnline: true, transactionDiscountSelected: false });
    expect(line).toMatchObject({ status: 'applied', unitDiscount: 10 });
    expect(cartLinePromotionDiscount(line, 3)).toBe(30);
    expect(cartLinePromotionAck(line)).toEqual({ promotion_id: promo.promotion_id, unit_discount: 10 });
  });

  it('is shown but not applied with PWD/Senior/Employee, and not applied offline — the ack is null', () => {
    const withDiscount = resolveCartLinePromotion(promo, { isOnline: true, transactionDiscountSelected: true });
    const offline = resolveCartLinePromotion(promo, { isOnline: false, transactionDiscountSelected: false });
    expect(withDiscount?.status).toBe('not_combinable');
    expect(offline?.status).toBe('offline');
    for (const line of [withDiscount, offline]) {
      expect(cartLinePromotionDiscount(line, 2)).toBe(0);
      expect(cartLinePromotionAck(line)).toBeNull();
    }
  });

  it('has no promotion when the catalog has none (or an older API sends no field)', () => {
    expect(resolveCartLinePromotion(undefined, { isOnline: true, transactionDiscountSelected: false })).toBeNull();
    expect(resolveCartLinePromotion(null, { isOnline: true, transactionDiscountSelected: false })).toBeNull();
    expect(cartLinePromotionAck(null)).toBeNull();
  });

  it('rounds the line discount per unit × quantity like the server', () => {
    const line = resolveCartLinePromotion({ ...promo, unit_discount: 5.85 }, { isOnline: true, transactionDiscountSelected: false });
    expect(cartLinePromotionDiscount(line, 3)).toBe(17.55);
  });

  it('describes a PROMOTION_CHANGED refusal per line, and ignores unknown shapes', () => {
    expect(
      describePromotionChanges({
        lines: [
          { product_name: 'Promo Fries', variant_name: 'Regular', shown: { unit_discount: 10 }, current: null },
          { product_name: 'Promo Fries', variant_name: 'Large', shown: null, current: { name: 'Twenty', unit_discount: 19.8 } },
        ],
      }),
    ).toEqual(['Promo Fries (Regular): was ₱10.00 off, now no promotion', 'Promo Fries (Large): was no promotion, now ₱19.80 off (Twenty)']);
    expect(describePromotionChanges(undefined)).toEqual([]);
    expect(describePromotionChanges({ lines: 'nope' })).toEqual([]);
  });
});
