export interface CreateExpenseTypeData {
  name: string;
  normalizedName: string;
  description: string | null;
  createdById: string;
}

export interface UpdateExpenseTypeData {
  name?: string;
  normalizedName?: string;
  description?: string | null;
  updatedById: string;
}

export class ExpenseTypeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExpenseTypeError';
  }
}
