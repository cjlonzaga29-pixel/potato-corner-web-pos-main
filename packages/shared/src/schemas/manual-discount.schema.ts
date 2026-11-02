import { z } from 'zod';

/**
 * POS-PERF-P55 — manual peso discounts. Rules live in
 * docs/runbooks/pos-perf-p55-manual-discounts-and-proof.md.
 *
 * A supervisor names a discount type for a branch and switches it on for the
 * POS (and, optionally, makes a proof photo required). The cashier enters the
 * amount in pesos for each sale. There is no rate, schedule or automatic
 * application anywhere in this model.
 *
 * POS-PERF-P57 — a type is either "staff enters the amount" or one fixed peso
 * amount for the whole order, and may be limited to selected products. One
 * supervisor action can set a type up at several branches: each branch keeps
 * its own row (group_id links them), so branch-level checks are unchanged.
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
 * POS-PERF-P57 — only used to show a notice. A supervisor may name a type
 * "PWD" or "Senior": it stays an ordinary manual peso discount. The name never
 * selects a calculation; the statutory formula is reached only by the legacy
 * discount_type values older clients send.
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

export const STATUTORY_DISCOUNT_NAME_NOTICE =
  'This will be recorded as a manual peso discount. The POS does not apply or verify the legal PWD/Senior Citizen formula, VAT exemption or ID check for it.';

/** POS-PERF-P57 — who decides the amount. */
export const MANUAL_DISCOUNT_AMOUNT_MODES = ['manual', 'fixed'] as const;
export type ManualDiscountAmountMode = (typeof MANUAL_DISCOUNT_AMOUNT_MODES)[number];

/** POS-PERF-P57 — 'all' is every product, including ones added later; 'selected' is exactly the stored list. */
export const MANUAL_DISCOUNT_PRODUCT_SCOPES = ['all', 'selected'] as const;
export type ManualDiscountProductScope = (typeof MANUAL_DISCOUNT_PRODUCT_SCOPES)[number];

/** Sent by a POS that can honor amount modes and product limits. Without it, GET /manual-types/pos lists only types an older POS charges correctly. */
export const MANUAL_DISCOUNT_POS_CAPABILITY = 'amount_modes_v1' as const;

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(MANUAL_DISCOUNT_TYPE_NAME_MAX, `Use at most ${MANUAL_DISCOUNT_TYPE_NAME_MAX} characters`);

const moneyAmountSchema = z
  .number()
  .finite('Enter a valid amount')
  .positive('Enter an amount greater than ₱0')
  .max(MANUAL_DISCOUNT_MAX_AMOUNT)
  .refine(hasTwoDecimals, { message: 'Use at most 2 decimal places (centavos)' });

const branchIdsSchema = z.array(z.uuid()).min(1, 'Choose at least one branch').max(200);
const productIdsSchema = z.array(z.uuid()).max(2000);

interface AmountAndScope {
  amount_mode?: ManualDiscountAmountMode | undefined;
  fixed_amount?: number | null | undefined;
  product_scope?: ManualDiscountProductScope | undefined;
  product_ids?: string[] | undefined;
}

function refineAmountAndScope(data: AmountAndScope, ctx: z.RefinementCtx): void {
  if (data.amount_mode === 'fixed' && (data.fixed_amount === undefined || data.fixed_amount === null)) {
    ctx.addIssue({ code: 'custom', path: ['fixed_amount'], message: 'Enter the fixed peso amount' });
  }
  if (data.amount_mode === 'manual' && data.fixed_amount !== undefined && data.fixed_amount !== null) {
    ctx.addIssue({ code: 'custom', path: ['fixed_amount'], message: 'A staff-entered discount has no fixed amount' });
  }
  if (data.amount_mode === undefined && data.fixed_amount !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['amount_mode'], message: 'Say how the amount is decided' });
  }
  if (data.product_scope === 'selected' && (data.product_ids?.length ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', path: ['product_ids'], message: 'Choose at least one product' });
  }
  if (data.product_scope === 'all' && (data.product_ids?.length ?? 0) > 0) {
    ctx.addIssue({ code: 'custom', path: ['product_ids'], message: 'A discount for all products has no product list' });
  }
  if (data.product_scope === undefined && data.product_ids !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['product_scope'], message: 'Say which products are eligible' });
  }
}

/** branch_id alone is what a P55/P56 web sends; both modes then default to the old behavior. */
export const createManualDiscountTypeSchema = z
  .object({
    branch_id: z.uuid().optional(),
    branch_ids: branchIdsSchema.optional(),
    name: nameSchema,
    apply_to_pos: z.boolean(),
    require_proof: z.boolean(),
    amount_mode: z.enum(MANUAL_DISCOUNT_AMOUNT_MODES).default('manual'),
    fixed_amount: moneyAmountSchema.nullable().optional(),
    product_scope: z.enum(MANUAL_DISCOUNT_PRODUCT_SCOPES).default('all'),
    product_ids: productIdsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.branch_id && !data.branch_ids) ctx.addIssue({ code: 'custom', path: ['branch_ids'], message: 'Choose at least one branch' });
    if (data.branch_id && data.branch_ids) ctx.addIssue({ code: 'custom', path: ['branch_id'], message: 'Send branch_id or branch_ids, not both' });
    refineAmountAndScope(data, ctx);
  });

export const updateManualDiscountTypeSchema = z
  .object({
    name: nameSchema.optional(),
    apply_to_pos: z.boolean().optional(),
    require_proof: z.boolean().optional(),
    amount_mode: z.enum(MANUAL_DISCOUNT_AMOUNT_MODES).optional(),
    fixed_amount: moneyAmountSchema.nullable().optional(),
    product_scope: z.enum(MANUAL_DISCOUNT_PRODUCT_SCOPES).optional(),
    product_ids: productIdsSchema.optional(),
    /** The branches this type should end up at. Present: also applied to its sibling rows there. Absent (older web): only this row changes. */
    branch_ids: branchIdsSchema.optional(),
    expected_version: z.number().int().positive(),
  })
  .superRefine((data, ctx) => {
    refineAmountAndScope(data, ctx);
    const changed = Object.entries(data).some(([key, value]) => key !== 'expected_version' && value !== undefined);
    if (!changed) ctx.addIssue({ code: 'custom', message: 'Nothing to change' });
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
  amount_mode: z.enum(MANUAL_DISCOUNT_AMOUNT_MODES),
  fixed_amount: z.number().nullable(),
  product_scope: z.enum(MANUAL_DISCOUNT_PRODUCT_SCOPES),
  product_ids: z.array(z.uuid()),
  /** Branches this type is active at, limited to those the reader may see. */
  branch_ids: z.array(z.uuid()),
});

/** What the POS needs to offer a type: only active, Apply-to-POS types of the terminal's own branch. */
export const posManualDiscountTypeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  require_proof: z.boolean(),
  version: z.number().int(),
  /** Absent from an API older than P57: the type is then staff-entered, for the whole order. */
  amount_mode: z.enum(MANUAL_DISCOUNT_AMOUNT_MODES).optional(),
  fixed_amount: z.number().nullable().optional(),
  product_scope: z.enum(MANUAL_DISCOUNT_PRODUCT_SCOPES).optional(),
  product_ids: z.array(z.uuid()).optional(),
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
  /**
   * Staff-entered: the cashier's entry. Fixed: the effective amount the screen
   * showed — only compared with what the server calculates, never used.
   */
  amount: manualDiscountAmountSchema,
  /** POS-PERF-P57 — acknowledges how the amount was decided. Absent = an older POS, which only knows staff-entered amounts. */
  amount_mode: z.enum(MANUAL_DISCOUNT_AMOUNT_MODES).optional(),
  /** Server-issued id from POST /api/transactions/discount-proof (never a storage key). */
  proof_upload_id: z.uuid().optional(),
  expected_total_amount: z.number().finite().nonnegative().optional(),
});

/**
 * Frozen onto transactions.manual_discount_snapshot when the sale is created.
 * Version 2 (P55R2): calculated without VAT; eligible_subtotal is the whole
 * order subtotal. Version 1 exists only on local pre-P55R2 test data.
 * P57 adds optional fields: eligible_subtotal is now what the type's product
 * scope allows (the whole order for scope 'all').
 */
export interface ManualDiscountSnapshot {
  version: 2;
  source: 'manual';
  calculation_mode: 'manual_total_v1';
  discount_type_id: string;
  name: string;
  require_proof: boolean;
  type_version: number;
  amount: number;
  eligible_subtotal: number;
  proof_upload_id: string | null;
  entered_by_id: string;
  amount_mode?: ManualDiscountAmountMode;
  fixed_amount?: number | null;
  capped_to_eligible?: boolean;
  product_scope?: ManualDiscountProductScope;
  eligible_product_ids?: string[];
  order_subtotal?: number;
}

/** Shown on receipts/history for a manual-discount sale; built from the snapshot only. */
export const transactionManualDiscountSchema = z.object({
  discount_type_id: z.string(),
  name: z.string(),
  amount: z.number(),
  require_proof: z.boolean(),
});
