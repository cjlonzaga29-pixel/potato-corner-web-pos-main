export class ProductTypeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductTypeError';
  }
}

export interface ProductTypeListFilters {
  /** Only types usable at this branch. */
  branch_id?: string;
  include_inactive: boolean;
}

export interface CreateProductTypeData {
  name: string;
  normalizedName: string;
  description: string | null;
  branchIds: string[];
  createdById: string;
}

export interface UpdateProductTypeData {
  name?: string;
  normalizedName?: string;
  description?: string | null;
  updatedById: string;
}
