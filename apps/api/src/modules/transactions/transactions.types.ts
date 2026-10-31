import type { ImageProofType, PaymentMethod } from '@potato-corner/shared';

/** Mirrors CashError/IngredientError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class TransactionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TransactionError';
  }
}

export interface CartItemInput {
  productId: string;
  productVariantId: string;
  flavorId?: string;
  /** Mix & Max slot selections — required instead of flavorId when the variant has ProductFlavorSlot rows. */
  selectedFlavors?: { slotIndex: number; snackProductVariantId: string; flavorId: string }[];
  /** CR-008 Product Options (Task 27) — IDs only, resolved via ProductOptionInventoryMapping (dedicated per-option deductions), not forwarded to computeBomDeduction. */
  selectedOptionIds?: string[];
  quantity: number;
  /**
   * POS-PERF-P49 — the promotion the cashier's screen showed for this line.
   * undefined = an older client that knows nothing about promotions (no
   * promotion is applied, it is charged what it displayed); null = "no
   * promotion shown". Never a price: createTransaction recomputes it and
   * refuses a mismatch with PROMOTION_CHANGED.
   */
  promotionAck?: { promotionId: string; unitDiscount: number } | null;
}

export interface CreateTransactionData {
  branchId: string;
  shiftId: string;
  cashierId: string;
  items: CartItemInput[];
  paymentMethod: PaymentMethod;
  discountType?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional' | 'manual';
  discountIdReference?: string;
  discountAmount?: number;
  cashTendered?: number;
  gcashReferenceNumber?: string;
  gcashManuallyVerified?: boolean;
  otherReferenceNote?: string;
  paymentProofKey?: string;
  paymentProofType?: ImageProofType;
  discountProofKey?: string;
  discountProofType?: ImageProofType;
  isOfflineTransaction: boolean;
  offlineProvisionalNumber?: string;
  /** Task 209.47 — X-Device-ID request header, already sent on every request by apps/web/lib/api-client.ts. Persisted only when isOfflineTransaction is true. */
  deviceId?: string | null;
  /**
   * POS-PERF-P15 — client-generated UUID, one per checkout attempt, stable
   * across that attempt's retries/double-clicks. Optional: a client that
   * omits it gets no idempotency protection (same behavior as before this
   * field existed), it is never required for checkout to succeed.
   */
  idempotencyKey?: string | null;
  /** POS-PERF-P25 — optional cashier-entered order note, already trimmed/normalized by createTransactionSchema. */
  notes?: string;
  /** POS-PERF-P50 — the VAT/discount rates the cashier's total was computed with; a mismatch is refused (TAX_SETTINGS_CHANGED). Absent = no check. */
  taxBasis?: TaxBasis;
  /** POS-PERF-P50R — the cashier-selected custom discount the screen showed (id + version). */
  selectedDiscount?: { promotionId: string; version: number };
  /** POS-PERF-P50R — the cashier's explicit decision when the branch requires one. */
  discountChoice?: 'selected' | 'none_applicable';
  /** POS-PERF-P55 — 'manual_v1' from the manual-discount checkout; absent = legacy client (pre-P55 rules). */
  discountFlow?: 'manual_v1';
  /** POS-PERF-P55 — the cashier-entered peso discount (new flow only). */
  manualDiscount?: ManualDiscountInput;
}

export interface ManualDiscountInput {
  discountTypeId: string;
  typeVersion: number;
  amount: number;
  proofUploadId?: string;
  expectedTotalAmount?: number;
}

export interface TaxBasis {
  vatRate: number;
  discountRate: number | null;
}

export interface UploadPaymentProofData {
  branchId: string;
  shiftId: string;
  type: ImageProofType;
}

export interface UploadDiscountProofData {
  branchId: string;
  shiftId: string;
  type: ImageProofType;
}

export interface TransactionListFilters {
  branchId?: string;
  shiftId?: string;
  status?: 'completed' | 'voided' | 'refunded';
  paymentMethod?: PaymentMethod;
  dateFrom?: string;
  dateTo?: string;
  /** POS-PERF-P40 — case-insensitive receipt-number substring. */
  receiptSearch?: string;
  page: number;
  limit: number;
}

export interface DiscountAuditFilters {
  branchIds: 'all' | string[];
  discountType?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional' | 'manual';
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

export interface CreateHoldOrderData {
  branchId: string;
  shiftId: string;
  cashierId: string;
  items: CartItemInput[];
}

export interface OfflineTransactionItemInput {
  offlineProvisionalNumber: string;
  /** P46R3 — absent only when neither the client nor shiftGuard supplied one (admin/supervisor without a shift id); that item fails INVALID_SHIFT. */
  shiftId: string | undefined;
  items: CartItemInput[];
  paymentMethod: PaymentMethod;
  discountType?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional' | 'manual';
  discountIdReference?: string;
  discountAmount?: number;
  cashTendered?: number;
  gcashReferenceNumber?: string;
  gcashManuallyVerified?: boolean;
  taxBasis?: TaxBasis;
  discountChoice?: 'selected' | 'none_applicable';
  /** POS-PERF-P55 — forwarded only so the sync can refuse a queued manual discount visibly. */
  discountFlow?: 'manual_v1';
  manualDiscount?: ManualDiscountInput;
  clientCreatedAt: number;
}

export interface SyncOfflineTransactionsData {
  branchId: string;
  cashierId: string;
  /** Task 209.47 — X-Device-ID request header; every queued item in one sync batch comes from the same device (same reasoning branchGuard/shiftGuard already apply to branch_id/shift_id). */
  deviceId: string | null;
  transactions: OfflineTransactionItemInput[];
}

/** Max held orders per terminal (Architecture doc §Part 8) — no separate "terminal" entity exists, so this is enforced per active shift. */
export const HOLD_ORDER_LIMIT_PER_TERMINAL = 3;
/** 15-minute expiry (Architecture doc §Part 8). */
export const HOLD_ORDER_EXPIRY_MS = 15 * 60 * 1000;
