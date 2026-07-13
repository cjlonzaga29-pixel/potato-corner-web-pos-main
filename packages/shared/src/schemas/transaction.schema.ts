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

export const cartItemSchema = z.object({
  productId: z.uuid(),
  productVariantId: z.uuid(),
  flavorId: z.uuid(),
  quantity: z.number().int().positive(),
});

/** Only one discount may be applied per transaction. */
export const discountSchema = z.object({
  type: z.enum(discountTypeValues),
  // Required for PWD and Senior Citizen discounts; recorded encrypted.
  customerIdNumber: z.string().min(1).optional(),
});

export const createTransactionSchema = z.object({
  branchId: z.uuid(),
  shiftId: z.uuid(),
  items: z.array(cartItemSchema).min(1),
  discount: discountSchema.optional(),
  paymentMethod: z.enum(paymentMethodValues),
  amountTendered: z.number().nonnegative().optional(),
  gcashReferenceNumber: z
    .string()
    .regex(/^\d{10,20}$/)
    .optional(),
  isOfflineTransaction: z.boolean().default(false),
  offlineProvisionalNumber: z.string().optional(),
});

export const voidTransactionRequestSchema = z.object({
  transactionId: z.uuid(),
  reason: z.string().min(10),
});

export const transactionResponseSchema = z.object({
  id: z.uuid(),
  transactionNumber: z.string(),
  branchId: z.uuid(),
  status: z.enum(transactionStatusValues),
  paymentMethod: z.enum(paymentMethodValues),
  subtotal: z.number(),
  discountAmount: z.number(),
  vatAmount: z.number(),
  totalAmount: z.number(),
  changeAmount: z.number().nullable(),
  createdAt: z.iso.datetime(),
});
