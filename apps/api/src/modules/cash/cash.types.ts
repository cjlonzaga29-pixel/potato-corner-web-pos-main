/** Mirrors IngredientError/ProductRequestError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class CashError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CashError';
  }
}

export interface DenominationCountInput {
  denomination: number;
  quantity: number;
}

export interface OpenShiftData {
  branchId: string;
  cashierId: string;
  openedBy: string;
  startingCash: number;
  denominations: DenominationCountInput[];
}

export interface CloseShiftData {
  denominations: DenominationCountInput[];
  notes?: string;
  varianceExplanation?: string;
}

export interface ApproveVarianceData {
  approved: boolean;
  notes: string;
}

export interface ShiftListFilters {
  branchId?: string;
  status?: 'active' | 'closed' | 'flagged';
  page: number;
  limit: number;
}

export interface ShiftCloseComputedCounts {
  cashSalesCount: number;
  gcashSalesCount: number;
  voidedCount: number;
  refundedCount: number;
  totalTransactionCount: number;
  totalDiscountAmount: number;
  pwdScTransactionCount: number;
}
