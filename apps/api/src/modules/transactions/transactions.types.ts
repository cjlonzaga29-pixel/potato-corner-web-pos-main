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
  quantity: number;
}

export interface CreateTransactionData {
  branchId: string;
  shiftId: string;
  cashierId: string;
  items: CartItemInput[];
  paymentMethod: 'cash' | 'gcash';
  discountType?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional';
  discountIdReference?: string;
  discountAmount?: number;
  cashTendered?: number;
  gcashReferenceNumber?: string;
  gcashManuallyVerified?: boolean;
  isOfflineTransaction: boolean;
  offlineProvisionalNumber?: string;
}

export interface TransactionListFilters {
  branchId?: string;
  shiftId?: string;
  status?: 'completed' | 'voided' | 'refunded';
  paymentMethod?: 'cash' | 'gcash';
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

export interface DiscountAuditFilters {
  branchIds: 'all' | string[];
  discountType?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional';
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
  shiftId: string;
  items: CartItemInput[];
  paymentMethod: 'cash' | 'gcash';
  discountType?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional';
  discountIdReference?: string;
  discountAmount?: number;
  cashTendered?: number;
  gcashReferenceNumber?: string;
  gcashManuallyVerified?: boolean;
  clientCreatedAt: number;
}

export interface SyncOfflineTransactionsData {
  branchId: string;
  cashierId: string;
  transactions: OfflineTransactionItemInput[];
}

/** Max held orders per terminal (Architecture doc §Part 8) — no separate "terminal" entity exists, so this is enforced per active shift. */
export const HOLD_ORDER_LIMIT_PER_TERMINAL = 3;
/** 15-minute expiry (Architecture doc §Part 8). */
export const HOLD_ORDER_EXPIRY_MS = 15 * 60 * 1000;
