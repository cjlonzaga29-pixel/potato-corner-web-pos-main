import { z } from 'zod';
import { IMAGE_PROOF_TYPE, PAYMENT_METHOD, type ImageProofType, type PaymentMethod } from '../constants/status.js';

/**
 * POS-PERF-P61 — Extra Supplies: additional cups, tissue and bags a customer gets free
 * or buys separately. A card owns no stock: an issue deducts the linked inventory item.
 * See docs/runbooks/pos-perf-p61-extra-supplies.md.
 */
const MAX_NAME = 60;
const MAX_BRANCHES = 100;
const MAX_ISSUE_LINES = 50;
/** One card, one issue. Well past any real counter request, and low enough that a typo can't empty a branch. */
export const MAX_EXTRA_SUPPLY_ISSUE_QUANTITY = 1000;

/** The one definition of "the same name", as normalizeExpenseTypeName. The unique index compares the stored result. */
export function normalizeExtraSupplyName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** How many issued units the available base quantity covers. Whole units only: half a cup can't be handed over. */
export function availableIssueQuantity(availableBaseQuantity: number, baseQuantityEach: number): number {
  if (baseQuantityEach <= 0 || availableBaseQuantity <= 0) return 0;
  // Compared in thousandths, the scale stock is stored at, so 0.3 / 0.1 is 3 and not 2.
  return Math.floor(Math.round(availableBaseQuantity * 1000) / Math.round(baseQuantityEach * 1000));
}

const nameSchema = z
  .string()
  .transform((name) => name.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Enter a name').max(MAX_NAME, `Use at most ${MAX_NAME} characters`));

const issueUnitNameSchema = z.string().trim().min(1, 'Enter what the cashier counts, such as cup or piece').max(30, 'Use at most 30 characters');
const branchIdsSchema = z.array(z.uuid()).min(1, 'Select at least one branch').max(MAX_BRANCHES);
const moneySchema = z.number().multipleOf(0.01, 'Use at most 2 decimal places').max(99_999_999);
const sellingPriceSchema = moneySchema.positive('A selling price must be above zero');
const issueCostSchema = z.number().nonnegative().multipleOf(0.0001, 'Use at most 4 decimal places').max(999_999);
const enteredQuantitySchema = z.number().positive('Enter a quantity above zero').max(99_999_999);

export const createExtraSupplySchema = z.object({
  name: nameSchema,
  inventory_item_id: z.uuid('Choose an inventory item'),
  issue_unit_name: issueUnitNameSchema,
  entered_quantity: enteredQuantitySchema,
  entered_unit_id: z.uuid('Choose a unit'),
  configured_issue_cost: issueCostSchema.nullable().optional(),
  selling_price: sellingPriceSchema.nullable().optional(),
  apply_to_pos: z.boolean().default(true),
  branch_ids: branchIdsSchema,
});

/** branch_ids is the whole new scope. A branch that has issued this card can't be removed: see the service. */
export const updateExtraSupplySchema = z.object({
  name: nameSchema.optional(),
  inventory_item_id: z.uuid().optional(),
  issue_unit_name: issueUnitNameSchema.optional(),
  entered_quantity: enteredQuantitySchema.optional(),
  entered_unit_id: z.uuid().optional(),
  configured_issue_cost: issueCostSchema.nullable().optional(),
  selling_price: sellingPriceSchema.nullable().optional(),
  apply_to_pos: z.boolean().optional(),
  branch_ids: branchIdsSchema.optional(),
  expected_version: z.number().int().positive(),
});

export const extraSupplyTransitionSchema = z.object({ expected_version: z.number().int().positive() });

/** Multipart, so its one number arrives as text. */
export const extraSupplyImageUploadSchema = z.object({ expected_version: z.coerce.number().int().positive() });

export const extraSupplyListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
});

export const extraSupplyConversionPreviewSchema = z.object({
  inventory_item_id: z.uuid(),
  entered_quantity: z.coerce.number().positive().max(99_999_999),
  entered_unit_id: z.uuid(),
});

export const extraSupplyTerminalQuerySchema = z.object({ branch_id: z.uuid() });

const paymentMethodValues = Object.values(PAYMENT_METHOD) as [PaymentMethod, ...PaymentMethod[]];
const imageProofTypeValues = Object.values(IMAGE_PROOF_TYPE) as [ImageProofType, ...ImageProofType[]];
const NON_CASH: readonly PaymentMethod[] = [PAYMENT_METHOD.GCASH, PAYMENT_METHOD.MAYA, PAYMENT_METHOD.OTHER];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

/**
 * No cashier or shift field exists here on purpose: the server takes both from the
 * authenticated session. No amount either: it calculates what to collect from the
 * selling prices it reads when the issue commits.
 */
export const createExtraSupplyIssueSchema = z
  .object({
    /** Made by the client before the first attempt and reused for every retry of it. */
    operation_id: z.uuid(),
    branch_id: z.uuid(),
    kind: z.enum(['free', 'paid']),
    lines: z
      .array(
        z.object({
          extra_supply_id: z.uuid(),
          quantity: z.number().int().positive('Enter a whole quantity above zero').max(MAX_EXTRA_SUPPLY_ISSUE_QUANTITY),
          /** The card version the cashier reviewed. A newer one is refused, not silently applied. */
          version: z.number().int().positive(),
        }),
      )
      .min(1, 'Select at least one supply')
      .max(MAX_ISSUE_LINES)
      .refine((lines) => new Set(lines.map((line) => line.extra_supply_id)).size === lines.length, { message: 'Each supply can appear only once' }),
    reason: optionalText(200),
    order_reference: optionalText(60),
    payment_method: z.enum(paymentMethodValues).optional(),
    cash_tendered: z.number().nonnegative().optional(),
    payment_reference: optionalText(200),
    payment_proof_key: z.string().min(1).max(500).optional(),
    payment_proof_type: z.enum(imageProofTypeValues).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'free') {
      if (!data.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Enter why these supplies are being given free' });
      const paymentFields = [data.payment_method, data.cash_tendered, data.payment_reference, data.payment_proof_key, data.payment_proof_type];
      if (paymentFields.some((field) => field !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['payment_method'], message: 'A free issue takes no payment details' });
      }
      return;
    }
    if (!data.payment_method) {
      ctx.addIssue({ code: 'custom', path: ['payment_method'], message: 'Choose a payment method' });
      return;
    }
    if (data.payment_method === PAYMENT_METHOD.CASH && data.cash_tendered === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cash_tendered'], message: 'Enter the cash received' });
    }
    if (NON_CASH.includes(data.payment_method) && (!data.payment_proof_key || !data.payment_proof_type)) {
      ctx.addIssue({ code: 'custom', path: ['payment_proof_key'], message: 'A payment proof photo is required for a GCash, Maya or Other payment' });
    }
  });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');

const issueFilterFields = {
  branch_id: z.uuid().optional(),
  date_from: dateOnly.optional(),
  date_to: dateOnly.optional(),
  extra_supply_id: z.uuid().optional(),
  kind: z.enum(['free', 'paid']).optional(),
  cashier_id: z.uuid().optional(),
};

export const extraSupplyIssueListQuerySchema = z.object({
  ...issueFilterFields,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const extraSupplyIssueSummaryQuerySchema = z.object(issueFilterFields);
export const extraSupplyIssueExportQuerySchema = z.object(issueFilterFields);

export const extraSupplyResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  image_url: z.string().nullable(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  inventory_item_available: z.boolean(),
  issue_unit_name: z.string(),
  entered_quantity: z.number(),
  entered_unit_id: z.uuid(),
  entered_unit_code: z.string(),
  base_quantity: z.number(),
  base_unit_code: z.string(),
  configured_issue_cost: z.number().nullable(),
  selling_price: z.number().nullable(),
  apply_to_pos: z.boolean(),
  is_active: z.boolean(),
  version: z.number().int(),
  /** Only the branches the caller can access. */
  branches: z.array(z.object({ branch_id: z.uuid(), branch_name: z.string() })),
  other_branch_count: z.number().int(),
  can_manage: z.boolean(),
  issue_count: z.number().int(),
});

export const extraSupplyListResponseSchema = z.object({ supplies: z.array(extraSupplyResponseSchema) });

export const extraSupplyConversionPreviewResponseSchema = z.object({
  inventory_item_name: z.string(),
  base_quantity: z.number(),
  base_unit_code: z.string(),
  entered_unit_code: z.string(),
  /** Where the inventory's carrying cost exists for the item. Null when it has none, so configured cost would apply. */
  item_unit_cost: z.number().nullable(),
});

export const extraSupplyTerminalCardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  image_url: z.string().nullable(),
  issue_unit_name: z.string(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  base_quantity: z.number(),
  base_unit_code: z.string(),
  selling_price: z.number().nullable(),
  version: z.number().int(),
  /** On hand less what pending sales have reserved, in the item's base unit. */
  available_base_quantity: z.number(),
  available_issue_quantity: z.number().int(),
});

export const extraSupplyTerminalResponseSchema = z.object({ cards: z.array(extraSupplyTerminalCardSchema) });

export const extraSupplyIssueLineResponseSchema = z.object({
  id: z.uuid(),
  extra_supply_id: z.uuid(),
  supply_name: z.string(),
  /** The card's name today. A rename never rewrites supply_name. */
  current_supply_name: z.string(),
  issue_unit_name: z.string(),
  quantity: z.number().int(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  base_unit_code: z.string(),
  base_quantity_each: z.number(),
  base_quantity_total: z.number(),
  unit_price: z.number().nullable(),
  line_amount: z.number(),
  cost_source: z.enum(['inventory', 'configured', 'unknown']),
  unit_cost: z.number().nullable(),
  line_cost: z.number().nullable(),
});

export const extraSupplyIssueResponseSchema = z.object({
  id: z.uuid(),
  reference_number: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  shift_id: z.uuid().nullable(),
  cashier_id: z.uuid(),
  cashier_name: z.string(),
  kind: z.enum(['free', 'paid']),
  payment_method: z.enum(paymentMethodValues).nullable(),
  amount_collected: z.number(),
  amount_tendered: z.number().nullable(),
  change_amount: z.number().nullable(),
  payment_reference: z.string().nullable(),
  has_payment_proof: z.boolean(),
  reason: z.string().nullable(),
  order_reference: z.string().nullable(),
  created_at: z.string(),
  lines: z.array(extraSupplyIssueLineResponseSchema),
  /** True when the server returned an issue it had already posted. */
  replayed: z.boolean().optional(),
});

export const extraSupplyIssueDetailResponseSchema = extraSupplyIssueResponseSchema.extend({
  movements: z.array(
    z.object({
      id: z.uuid(),
      inventory_item_id: z.uuid(),
      inventory_item_name: z.string(),
      quantity_change: z.number(),
      quantity_before: z.number(),
      quantity_after: z.number(),
      unit_code: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

export const extraSupplyIssueListResponseSchema = z.object({
  issues: z.array(extraSupplyIssueResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const extraSupplyOperationResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('committed'), issue: extraSupplyIssueResponseSchema }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('abandoned') }),
]);

const summaryCostFields = {
  units_free: z.number().int(),
  units_paid: z.number().int(),
  amount_collected: z.number(),
  /** From the inventory's carrying cost. */
  inventory_cost: z.number(),
  /** From a cost the supervisor stated on the card. Not an accounting figure. */
  configured_cost: z.number(),
  /** Lines with neither. Left out of both costs, never counted as zero. */
  unknown_cost_lines: z.number().int(),
};

export const extraSupplySummaryResponseSchema = z.object({
  issue_count: z.number().int(),
  ...summaryCostFields,
  by_payment_method: z.array(z.object({ payment_method: z.enum(paymentMethodValues), amount: z.number(), line_count: z.number().int() })),
  by_branch: z.array(z.object({ branch_id: z.uuid(), branch_name: z.string(), ...summaryCostFields })),
  by_supply: z.array(z.object({ extra_supply_id: z.uuid(), name: z.string(), ...summaryCostFields })),
  by_cashier: z.array(z.object({ cashier_id: z.uuid(), name: z.string(), ...summaryCostFields })),
  /**
   * Completed product sales for the same branches, dates and cashier. Null when the
   * filter names a supply or free/paid, which doesn't apply to a product sale.
   */
  product_sales_total: z.number().nullable(),
  /** product_sales_total + amount_collected. Never stored and never added to either. */
  combined_collection_total: z.number().nullable(),
});
