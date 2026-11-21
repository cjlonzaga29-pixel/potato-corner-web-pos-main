export interface ExpenseFilters {
  branchIds: 'all' | string[];
  branch_id?: string;
  expense_type_id?: string;
  category?: string;
  unassigned?: boolean;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

export type ExpenseSummaryFilters = Omit<ExpenseFilters, 'page' | 'limit'>;

export interface CreateExpenseData {
  branchId: string;
  category: string;
  amount: number;
  vendorName?: string;
  description?: string;
  incurredAt: Date;
}

export type UpdateExpenseData = Partial<CreateExpenseData> & {
  expenseTypeId?: string;
  expenseTypeName?: string;
};

export interface IdempotencyClaim {
  key: string;
  userId: string;
  requestHash: string;
}

/** Every module maps its own domain errors to HTTP status via its router's error handler. */
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
