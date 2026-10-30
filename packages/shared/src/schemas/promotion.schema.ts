import { z } from 'zod';

/**
 * POS-PERF-P49 — product-scoped promotional discounts. Rules live in
 * docs/runbooks/pos-perf-p49-promotional-seasonal-products-and-discounts.md §3.
 */
export const PROMOTION_DISCOUNT_KINDS = ['percentage', 'fixed_amount'] as const;
export type PromotionDiscountKind = (typeof PROMOTION_DISCOUNT_KINDS)[number];

/** Upper bound for a fixed per-unit amount; far above any menu price. */
export const PROMOTION_MAX_FIXED_AMOUNT = 100_000;
const MAX_PROMOTION_PRODUCTS = 200;
const MAX_PROMOTION_BRANCHES = 100;

function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * The one pricing rule, shared by the API (POS catalog + authoritative
 * checkout) and the web editor preview so they can never disagree.
 *
 * basePrice is the size's own base price — flavor premiums and add-on
 * options are never discounted. Percentage rounds once per unit to cents
 * (same Math.round half-up as checkout's round2). Fixed amount is per unit,
 * capped at the base price, so a unit can reach 0 but never go negative.
 */
export function computePromotionUnitDiscount(basePrice: number, kind: PromotionDiscountKind, value: number): number {
  if (!(basePrice > 0) || !(value > 0)) return 0;
  const raw = kind === 'percentage' ? roundToCents(basePrice * (Math.min(value, 100) / 100)) : roundToCents(value);
  return Math.min(raw, roundToCents(basePrice));
}

const hasTwoDecimals = (value: number) => Math.round(value * 100) / 100 === value;

const uniqueIds = (max: number, label: string) =>
  z
    .array(z.uuid())
    .min(1, `Select at least one ${label}`)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: `Duplicate ${label} ids are not allowed` });

const promotionFields = {
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  discount_kind: z.enum(PROMOTION_DISCOUNT_KINDS),
  discount_value: z.number().positive('Enter an amount greater than 0').refine(hasTwoDecimals, { message: 'Use at most 2 decimal places' }),
  is_enabled: z.boolean().default(true),
  // Asia/Manila calendar dates, both inclusive. null/omitted = open-ended.
  starts_on: z.iso.date().nullable().optional(),
  ends_on: z.iso.date().nullable().optional(),
  product_ids: uniqueIds(MAX_PROMOTION_PRODUCTS, 'product'),
  branch_ids: uniqueIds(MAX_PROMOTION_BRANCHES, 'branch'),
};

function refinePromotion(
  data: { discount_kind: PromotionDiscountKind; discount_value: number; starts_on?: string | null; ends_on?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (data.discount_kind === 'percentage' && data.discount_value > 100) {
    ctx.addIssue({ code: 'custom', path: ['discount_value'], message: 'A percentage cannot exceed 100' });
  }
  if (data.discount_kind === 'fixed_amount' && data.discount_value > PROMOTION_MAX_FIXED_AMOUNT) {
    ctx.addIssue({ code: 'custom', path: ['discount_value'], message: `A fixed amount cannot exceed ${PROMOTION_MAX_FIXED_AMOUNT}` });
  }
  if (data.starts_on && data.ends_on && data.ends_on < data.starts_on) {
    ctx.addIssue({ code: 'custom', path: ['ends_on'], message: 'End date must not be before the start date' });
  }
}

export const createPromotionSchema = z.object(promotionFields).superRefine(refinePromotion);

export const updatePromotionSchema = z
  .object({ ...promotionFields, expected_version: z.number().int().positive() })
  .superRefine(refinePromotion);

export const setPromotionEnabledSchema = z.object({
  is_enabled: z.boolean(),
  expected_version: z.number().int().positive(),
});

export const promotionListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
});

export const promotionResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  discount_kind: z.enum(PROMOTION_DISCOUNT_KINDS),
  discount_value: z.number(),
  is_enabled: z.boolean(),
  starts_on: z.iso.date().nullable(),
  ends_on: z.iso.date().nullable(),
  /** 'active' | 'scheduled' | 'expired' | 'disabled' — evaluated now, Asia/Manila. */
  schedule_state: z.enum(['active', 'scheduled', 'expired', 'disabled']),
  version: z.number().int(),
  products: z.array(z.object({ id: z.uuid(), name: z.string(), classification: z.string() })),
  branches: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** false when the promotion covers a branch outside the caller's live authority — read-only for them. */
  can_edit: z.boolean(),
  read_only_reason: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

/** One selectable product in the editor, with each size's base price for the preview. */
export const promotionEligibleProductSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  classification: z.string(),
  status: z.string(),
  branch_ids: z.array(z.uuid()),
  /** null when selectable; otherwise why it can't be selected. */
  ineligible_reason: z.string().nullable(),
  variants: z.array(z.object({ id: z.uuid(), name: z.string(), base_price: z.number(), is_active: z.boolean() })),
});

/**
 * Checkout acknowledgement, per cart item: what the cashier's screen showed.
 * Never a price — the server recomputes and refuses a mismatch
 * (PROMOTION_CHANGED). Absent = an older client: no promotion is applied.
 */
export const cartItemPromotionAckSchema = z
  .object({
    promotion_id: z.uuid(),
    unit_discount: z.number().nonnegative(),
  })
  .nullable()
  .optional();
