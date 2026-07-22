export interface ExpenseFilters {
  branchIds: 'all' | string[];
  branch_id?: string;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

export interface CreateExpenseData {
  branchId: string;
  category: string;
  amount: number;
  vendorName?: string;
  description?: string;
  incurredAt: Date;
}

export type UpdateExpenseData = Partial<CreateExpenseData>;

/** Mirrors PriceOverrideError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ExpenseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExpenseError';
  }
}
