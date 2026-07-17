import { z } from 'zod';
import {
  PAYMENT_METHOD,
  type PaymentMethod,
  DISCOUNT_TYPE,
  type DiscountType,
  TRANSACTION_STATUS,
  type TransactionStatus,
} from '../constants/status.js';

const paymentMethodValues = Object.values(PAYMENT_METHOD) as [PaymentMethod, ...PaymentMethod[]];
const discountTypeValues = Object.values(DISCOUNT_TYPE) as [DiscountType, ...DiscountType[]];
const transactionStatusValues = Object.values(TRANSACTION_STATUS) as [
  TransactionStatus,
  ...TransactionStatus[],
];

/** flavor_id is optional — not every product variant has flavors to choose from. */
export const cartItemSchema = z.object({
  product_id: z.uuid(),
  product_variant_id: z.uuid(),
  flavor_id: z.uuid().optional(),
  quantity: z.number().int().positive(),
});

export const createTransactionSchema = z
  .object({
    branch_id: z.uuid(),
    shift_id: z.uuid(),
    items: z.array(cartItemSchema).min(1),
    payment_method: z.enum(paymentMethodValues),
    discount_type: z.enum(discountTypeValues).optional(),
    // PWD/Senior Citizen only — logged encrypted for BIR compliance.
    discount_id_reference: z.string().min(1).optional(),
    // PROMO only — passed directly rather than computed (architecture doc §Discounts).
    discount_amount: z.number().nonnegative().optional(),
    cash_tendered: z.number().nonnegative().optional(),
    gcash_reference_number: z
      .string()
      .regex(/^\d{10,20}$/)
      .optional(),
    gcash_manually_verified: z.boolean().optional(),
    is_offline_transaction: z.boolean().default(false),
    offline_provisional_number: z.string().optional(),
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
