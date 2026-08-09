import { z } from 'zod';
import {
  PAYMENT_METHOD,
  type PaymentMethod,
  DISCOUNT_TYPE,
  type DiscountType,
  TRANSACTION_STATUS,
  type TransactionStatus,
  IMAGE_PROOF_TYPE,
  type ImageProofType,
} from '../constants/status.js';

const paymentMethodValues = Object.values(PAYMENT_METHOD) as [PaymentMethod, ...PaymentMethod[]];
const discountTypeValues = Object.values(DISCOUNT_TYPE) as [DiscountType, ...DiscountType[]];
const transactionStatusValues = Object.values(TRANSACTION_STATUS) as [
  TransactionStatus,
  ...TransactionStatus[],
];
const imageProofTypeValues = Object.values(IMAGE_PROOF_TYPE) as [ImageProofType, ...ImageProofType[]];

/**
 * flavor_id is optional — not every product variant has flavors to choose
 * from. selected_flavors is the Mix & Max alternative used instead of
 * flavor_id when the variant has ProductFlavorSlot rows: one entry per slot.
 */
export const cartItemSchema = z.object({
  product_id: z.uuid(),
  product_variant_id: z.uuid(),
  flavor_id: z.uuid().optional(),
  selected_flavors: z
    .array(
      z.object({
        slot_index: z.number().int(),
        snack_product_variant_id: z.uuid(),
        flavor_id: z.uuid(),
      }),
    )
    .optional(),
  // CR-008 Product Options (Task 26) — IDs only, transported from the POS cart
  // to checkout. Display metadata (names, price_adjustment) is frontend-only
  // and never trusted as a backend field. Selected Product Option IDs used
  // for server-side validation, pricing, and inventory deduction.
  selected_option_ids: z.array(z.uuid()).optional(),
  quantity: z.number().int().positive(),
});

/** GCash, Maya, and Other all carry identical proof requirements — a payment proof photo, no reference number/note (Task 139). */
const PROOF_REQUIRED_METHODS: readonly PaymentMethod[] = [PAYMENT_METHOD.GCASH, PAYMENT_METHOD.MAYA, PAYMENT_METHOD.OTHER];

export const createTransactionSchema = z
  .object({
    branch_id: z.uuid(),
    // Optional — shiftGuard resolves (and auto-opens) the authenticated
    // cashier's own active shift onto req.activeShift server-side, which the
    // router trusts over this value for staff/branch. Only the
    // shiftGuard-exempt admin/supervisor path falls back to it. The cashier
    // is never blocked from checking out for want of a client-known shift id.
    shift_id: z.uuid().optional(),
    items: z.array(cartItemSchema).min(1),
    payment_method: z.enum(paymentMethodValues),
    discount_type: z.enum(discountTypeValues).optional(),
    // PWD/Senior Citizen only — logged encrypted for BIR compliance.
    discount_id_reference: z.string().min(1).optional(),
    // PROMO only — passed directly rather than computed (architecture doc §Discounts).
    discount_amount: z.number().nonnegative().optional(),
    cash_tendered: z.number().nonnegative().optional(),
    // Deprecated (Task 139) — no longer collected or required by the POS UI;
    // kept optional here only so older clients/queued payloads still parse.
    gcash_reference_number: z
      .string()
      .regex(/^\d{10,20}$/)
      .optional(),
    gcash_manually_verified: z.boolean().optional(),
    other_reference_note: z.string().min(1).max(200).optional(),
    // Storage key + capture mode returned by POST /api/transactions/payment-proof
    // — required together for GCash/Maya/Other (see superRefine below).
    payment_proof_key: z.string().min(1).optional(),
    payment_proof_type: z.enum(imageProofTypeValues).optional(),
    // Task 209.5 — storage key + capture mode returned by POST
    // /api/transactions/discount-proof, for PWD/Senior Citizen discount
    // compliance evidence. Always optional: no proof-required policy exists
    // for discounts yet (DISCOUNT_PROOF_REQUIREMENT_POLICY_MISSING), so this
    // is never enforced via superRefine the way payment_proof_key is.
    discount_proof_key: z.string().min(1).optional(),
    discount_proof_type: z.enum(imageProofTypeValues).optional(),
    is_offline_transaction: z.boolean().default(false),
    offline_provisional_number: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.payment_method === PAYMENT_METHOD.CASH && data.cash_tendered === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cash_tendered'], message: 'cash_tendered is required for a cash payment' });
    }
    if (PROOF_REQUIRED_METHODS.includes(data.payment_method) && (!data.payment_proof_key || !data.payment_proof_type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['payment_proof_key'],
        message: 'payment_proof_key and payment_proof_type are required for a GCash, Maya, or Other payment',
      });
    }
    // Proof capture requires a live, confirmed upload before the sale is
    // created — there's no offline blob queue for it, so GCash/Maya/Other
    // sales can't be queued while offline (see terminal/page.tsx's offline
    // guard).
    if (data.is_offline_transaction && data.payment_method !== PAYMENT_METHOD.CASH) {
      ctx.addIssue({
        code: 'custom',
        path: ['payment_method'],
        message: 'Offline sales must be paid in cash — non-cash payment proof cannot be captured while offline',
      });
    }
  });

export const voidTransactionRequestSchema = z.object({
  void_reason: z.string().min(10),
});

export const refundTransactionRequestSchema = z.object({
  refund_reason: z.string().min(10),
});

export const transactionListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  shift_id: z.uuid().optional(),
  status: z.enum(transactionStatusValues).optional(),
  payment_method: z.enum(paymentMethodValues).optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const discountAuditQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  discount_type: z.enum(['pwd', 'senior_citizen', 'employee', 'manager_override', 'promotional']).optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

/**
 * Task 209.16 — GET /api/transactions/discount-audit's per-transaction row
 * (transactionsService.getDiscountAuditTrail), which is what powers the
 * Discount Compliance report's Admin drill-down. Field names stay camelCase
 * (unlike transactionResponseSchema's snake_case) because this endpoint
 * returns the service's row shape as-is rather than going through a
 * dedicated toXResponse mapper.
 *
 * discountCustomerId is populated only for a super_admin actor (see the
 * service) — null for every other role, by design, not a bug. hasDiscountProof
 * is an existence flag only, same as transactionResponseSchema's
 * has_discount_proof: the raw discount_proof_key never leaves the server.
 */
export const discountAuditTransactionRowSchema = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  transactionNumber: z.string(),
  cashierId: z.uuid(),
  discountType: z.enum(discountTypeValues).nullable(),
  discountAmount: z.number(),
  discountCustomerId: z.string().nullable(),
  discountCustomerIdHash: z.string().nullable(),
  hasDiscountProof: z.boolean(),
  discountProofType: z.enum(imageProofTypeValues).nullable(),
  fraudFlagged: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type DiscountAuditTransactionRow = z.infer<typeof discountAuditTransactionRowSchema>;

export const discountAuditTrailResponseSchema = z.object({
  data: z.array(discountAuditTransactionRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type DiscountAuditTrailResponse = z.infer<typeof discountAuditTrailResponseSchema>;

/** Task 93 — the sale-time snapshot of one Product Option selected on a transaction line, as returned in transactionItemResponseSchema.selected_options. */
export const transactionItemSelectedOptionSchema = z.object({
  option_id: z.uuid(),
  option_name: z.string(),
  option_group_id: z.uuid(),
  option_group_name: z.string(),
  price_adjustment: z.number(),
});

export const transactionItemResponseSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  product_variant_id: z.uuid(),
  flavor_id: z.uuid().nullable(),
  product_name: z.string(),
  variant_name: z.string(),
  flavor_name: z.string().nullable(),
  unit_price: z.number(),
  quantity: z.number().int(),
  line_total: z.number(),
  // CR-004: the master Recipe.version(s) in effect for this line's
  // deduction at sale time — frozen, same as the snapshot fields above.
  recipe_version: z.number().int(),
  // Task 93: frozen at checkout via TransactionItem.selectedOptions — the
  // Product Options actually charged/deducted for this line. Empty array
  // when none were selected, never omitted.
  selected_options: z.array(transactionItemSelectedOptionSchema),
});

export const transactionResponseSchema = z.object({
  id: z.uuid(),
  receipt_number: z.string(),
  branch_id: z.uuid(),
  shift_id: z.uuid().nullable(),
  cashier_id: z.uuid(),
  status: z.enum(transactionStatusValues),
  payment_method: z.enum(paymentMethodValues),
  subtotal: z.number(),
  discount_amount: z.number(),
  discount_type: z.enum(discountTypeValues).nullable(),
  vat_amount: z.number(),
  vat_exempt_amount: z.number(),
  total_amount: z.number(),
  cash_tendered: z.number().nullable(),
  change_given: z.number().nullable(),
  gcash_reference_number: z.string().nullable(),
  gcash_manually_verified: z.boolean().nullable(),
  // Generic alias for gcash_reference_number — populated for gcash, maya,
  // and other alike (the underlying gcash_reference column stores any
  // non-cash payment's reference/note, not only GCash's). Prefer this field
  // in new code; gcash_reference_number is kept for existing callers.
  payment_reference: z.string().nullable(),
  // Existence flag only — never the raw key or a signed URL, so list
  // responses stay cheap. The actual signed URL is fetched lazily via
  // GET /:transactionId/payment-proof only when a viewer opens the dialog.
  has_payment_proof: z.boolean(),
  payment_proof_type: z.enum(imageProofTypeValues).nullable(),
  payment_proof_uploaded_at: z.iso.datetime().nullable(),
  // Task 209.5 — same existence-flag pattern as has_payment_proof above; the
  // signed URL is fetched lazily via GET /:transactionId/discount-proof only
  // when an authorized viewer opens the Discount Compliance report's dialog.
  has_discount_proof: z.boolean(),
  discount_proof_type: z.enum(imageProofTypeValues).nullable(),
  discount_proof_uploaded_at: z.iso.datetime().nullable(),
  receipt_printed: z.boolean(),
  inventory_deduction_status: z.enum(['pending', 'completed', 'failed']),
  is_offline_transaction: z.boolean(),
  offline_provisional_number: z.string().nullable(),
  synced_at: z.iso.datetime().nullable(),
  voided_at: z.iso.datetime().nullable(),
  voided_by_id: z.uuid().nullable(),
  void_reason: z.string().nullable(),
  refunded_at: z.iso.datetime().nullable(),
  refunded_by_id: z.uuid().nullable(),
  refund_reason: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  items: z.array(transactionItemResponseSchema).optional(),
});

export const transactionListResponseSchema = z.object({
  transactions: z.array(transactionResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

/**
 * One offline-queued sale within a reconnect-sync batch (Architecture doc
 * §Part 10). Shaped like createTransactionSchema but branch-scoped to the
 * batch's declared branch_id and always carrying its own provisional
 * number — is_offline_transaction is implied true, not repeated per item.
 */
export const offlineTransactionItemSchema = z
  .object({
    offline_provisional_number: z.string().min(1),
    shift_id: z.uuid(),
    items: z.array(cartItemSchema).min(1),
    payment_method: z.enum(paymentMethodValues),
    discount_type: z.enum(discountTypeValues).optional(),
    discount_id_reference: z.string().min(1).optional(),
    discount_amount: z.number().nonnegative().optional(),
    cash_tendered: z.number().nonnegative().optional(),
    gcash_reference_number: z
      .string()
      .regex(/^\d{10,20}$/)
      .optional(),
    gcash_manually_verified: z.boolean().optional(),
    // Epoch ms from the client's Dexie queue (createdAt) — the server sorts
    // the batch by this before processing, per the architecture doc's "sync
    // queue processes transactions in chronological order" rule.
    client_created_at: z.number().int().nonnegative(),
  })
  .superRefine((data, ctx) => {
    if (data.payment_method === PAYMENT_METHOD.CASH && data.cash_tendered === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cash_tendered'], message: 'cash_tendered is required for a cash payment' });
    }
    if (data.payment_method === PAYMENT_METHOD.GCASH && !data.gcash_reference_number) {
      ctx.addIssue({
        code: 'custom',
        path: ['gcash_reference_number'],
        message: 'gcash_reference_number is required for a GCash payment',
      });
    }
    // Every item in this schema is inherently offline-originated (see
    // createTransactionSchema's parallel rule) — payment proof can't have
    // been captured for a sale that was never online to upload it.
    if (data.payment_method !== PAYMENT_METHOD.CASH) {
      ctx.addIssue({
        code: 'custom',
        path: ['payment_method'],
        message: 'Offline-queued sales must be paid in cash',
      });
    }
  });

export const syncOfflineTransactionsSchema = z.object({
  branch_id: z.uuid(),
  transactions: z.array(offlineTransactionItemSchema).min(1),
});

export const syncOfflineTransactionResultSchema = z.object({
  offline_provisional_number: z.string(),
  status: z.enum(['synced', 'failed']),
  transaction: transactionResponseSchema.optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
});

export const syncOfflineTransactionsResponseSchema = z.object({
  results: z.array(syncOfflineTransactionResultSchema),
  synced_count: z.number().int(),
});

/** Architecture doc §Part 8 "Hold orders": max 3 per terminal, 15-min expiry. */
export const createHoldOrderSchema = z.object({
  branch_id: z.uuid(),
  shift_id: z.uuid(),
  items: z.array(cartItemSchema).min(1),
});

export const holdOrderItemResponseSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  product_variant_id: z.uuid(),
  flavor_id: z.uuid().nullable(),
  product_name: z.string(),
  variant_name: z.string(),
  flavor_name: z.string().nullable(),
  unit_price: z.number(),
  quantity: z.number().int(),
});

export const holdOrderResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  shift_id: z.uuid(),
  cashier_id: z.uuid(),
  status: z.enum(['held', 'released', 'expired']),
  expires_at: z.iso.datetime(),
  released_at: z.iso.datetime().nullable(),
  expired_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  items: z.array(holdOrderItemResponseSchema),
});

export const holdOrderListResponseSchema = z.object({
  hold_orders: z.array(holdOrderResponseSchema),
});

/**
 * POST /api/transactions/payment-proof multipart fields (the `proof` file
 * itself is parsed by multer, not Zod) — uploaded and confirmed before the
 * sale is created, since a Storage upload must not happen inside the atomic
 * transaction-create write.
 */
export const paymentProofUploadRequestSchema = z.object({
  branch_id: z.uuid(),
  // Optional for the same reason as createTransactionSchema.shift_id above —
  // shiftGuard resolves the active shift server-side for staff/branch.
  shift_id: z.uuid().optional(),
  type: z.enum(imageProofTypeValues),
});

export const paymentProofUploadResponseSchema = z.object({
  payment_proof_key: z.string(),
  payment_proof_type: z.enum(imageProofTypeValues),
});

export const paymentProofResponseSchema = z.object({
  payment_proof_url: z.url().nullable(),
  payment_proof_type: z.enum(imageProofTypeValues).nullable(),
  uploaded_at: z.iso.datetime().nullable(),
});

/**
 * Task 209.5 — POST /api/transactions/discount-proof multipart fields (the
 * `proof` file itself is parsed by multer, not Zod). Same shape and
 * upload-before-create rationale as paymentProofUploadRequestSchema above,
 * but for PWD/Senior Citizen discount compliance evidence — kept as its own
 * schema/endpoint/bucket rather than reusing the payment-proof one, so
 * payment and discount evidence are never ambiguous in storage or in the
 * request contract.
 */
export const discountProofUploadRequestSchema = z.object({
  branch_id: z.uuid(),
  shift_id: z.uuid().optional(),
  type: z.enum(imageProofTypeValues),
});

export const discountProofUploadResponseSchema = z.object({
  discount_proof_key: z.string(),
  discount_proof_type: z.enum(imageProofTypeValues),
});

export const discountProofResponseSchema = z.object({
  discount_proof_url: z.url().nullable(),
  discount_proof_type: z.enum(imageProofTypeValues).nullable(),
  uploaded_at: z.iso.datetime().nullable(),
});
