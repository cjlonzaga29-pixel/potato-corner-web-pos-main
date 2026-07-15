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
