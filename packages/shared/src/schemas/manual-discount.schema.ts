import { z } from 'zod';

/**
 * POS-PERF-P55 — manual peso discounts. Rules live in
 * docs/runbooks/pos-perf-p55-manual-discounts-and-proof.md.
 *
 * A supervisor names a discount type for a branch and switches it on for the
 * POS (and, optionally, makes a proof photo required). The cashier enters the
 * amount in pesos for each sale. There is no rate, schedule, product scope or
 * automatic application anywhere in this model.
 */

/**
 * The checkout payload version that opts a sale into the P55 rules. Without
 * it a request is a legacy client and is handled exactly as before P55.
 */
export const MANUAL_DISCOUNT_FLOW = 'manual_v1' as const;
export const DISCOUNT_FLOWS = [MANUAL_DISCOUNT_FLOW] as const;
export type DiscountFlow = (typeof DISCOUNT_FLOWS)[number];

/** transactions.discount_type of a manual peso discount sale. Written by the server only; never accepted as a client discount_type. */
export const MANUAL_DISCOUNT_TYPE = 'manual' as const;

export const MANUAL_DISCOUNT_TYPE_NAME_MAX = 60;
/** Upper bound for one sale's manual discount; far above any realistic order. */
export const MANUAL_DISCOUNT_MAX_AMOUNT = 999_999.99;

const hasTwoDecimals = (value: number) => Math.round(value * 100) / 100 === value;

/**
 * PWD and Senior Citizen discounts are statutory (RA 10754 / RA 9994): their
 * rate and VAT exemption come from the law and are calculated by the
 * statutory formula, never entered as a peso amount. A manual type with such
 * a name would record a taxable commercial discount under a statutory label,
 * so those names are reserved.
 */
const STATUTORY_NAME_PATTERNS: readonly RegExp[] = [
  /\bpwds?\b/i,
  /\bsenior\b/i,
  /\bsc\b/i,
  /\bosca\b/i,
  /\bdisabilit(y|ies)\b/i,
  /\bdisabled\b/i,
  /\bnaac\b/i,
];

export function isStatutoryDiscountName(name: string): boolean {
  return STATUTORY_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export const STATUTORY_DISCOUNT_NAME_MESSAGE =
  'PWD and Senior Citizen discounts are set by law and keep their own VAT-exempt calculation, so they cannot be created as a manual peso discount. Cashiers choose them under "Statutory" at checkout.';

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(MANUAL_DISCOUNT_TYPE_NAME_MAX, `Use at most ${MANUAL_DISCOUNT_TYPE_NAME_MAX} characters`);

export const createManualDiscountTypeSchema = z.object({
  branch_id: z.uuid(),
  name: nameSchema,
  apply_to_pos: z.boolean(),
  require_proof: z.boolean(),
});

export const updateManualDiscountTypeSchema = z
  .object({
    name: nameSchema.optional(),
    apply_to_pos: z.boolean().optional(),
    require_proof: z.boolean().optional(),
    expected_version: z.number().int().positive(),
  })
  .refine((data) => data.name !== undefined || data.apply_to_pos !== undefined || data.require_proof !== undefined, {
    message: 'Nothing to change',
  });

export const deactivateManualDiscountTypeSchema = z.object({
  expected_version: z.number().int().positive(),
});

export const manualDiscountTypeListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const manualDiscountTypeResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  name: z.string(),
  apply_to_pos: z.boolean(),
  require_proof: z.boolean(),
  is_active: z.boolean(),
  version: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  deactivated_at: z.iso.datetime().nullable(),
  /** Sales recorded with this type (so the UI can say why it can only be deactivated). */
  sale_count: z.number().int(),
  can_edit: z.boolean(),
});

/** What the POS needs to offer a type: only active, Apply-to-POS types of the terminal's own branch. */
export const posManualDiscountTypeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  require_proof: z.boolean(),
  version: z.number().int(),
});

export const manualDiscountAmountSchema = z
  .number()
  .finite('Enter a valid amount')
  .positive('Enter an amount greater than ₱0, or choose No discount')
  .max(MANUAL_DISCOUNT_MAX_AMOUNT)
  .refine(hasTwoDecimals, { message: 'Use at most 2 decimal places (centavos)' });

/**
 * The manual discount a new-flow checkout claims. The amount is the
 * cashier's entry; the server re-checks it against the order it prices
 * itself. type_version and expected_total_amount are acknowledgements of
 * what the screen showed — never trusted, only compared — so a changed type
 * or a changed total is refused instead of charged.
 */
export const checkoutManualDiscountSchema = z.object({
  discount_type_id: z.uuid(),
  type_version: z.number().int().positive(),
  amount: manualDiscountAmountSchema,
  /** Server-issued id from POST /api/transactions/discount-proof (never a storage key). */
  proof_upload_id: z.uuid().optional(),
  expected_total_amount: z.number().finite().nonnegative().optional(),
});

/** Frozen onto transactions.manual_discount_snapshot when the sale is created. */
export interface ManualDiscountSnapshot {
  version: 1;
  source: 'manual';
  discount_type_id: string;
  name: string;
  require_proof: boolean;
  type_version: number;
  amount: number;
  eligible_subtotal: number;
  proof_upload_id: string | null;
  entered_by_id: string;
}

/** Shown on receipts/history for a manual-discount sale; built from the snapshot only. */
export const transactionManualDiscountSchema = z.object({
  discount_type_id: z.string(),
  name: z.string(),
  amount: z.number(),
  require_proof: z.boolean(),
});
