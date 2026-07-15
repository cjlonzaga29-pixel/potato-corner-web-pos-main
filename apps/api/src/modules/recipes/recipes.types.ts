/** Mirrors ProductError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class RecipeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RecipeError';
  }
}

export interface DeductionLine {
  ingredient_id: string;
  ingredient_name: string;
  quantity: number;
  unit: string;
  source: 'master_base' | 'master_flavor' | 'branch_base' | 'branch_flavor';
}
