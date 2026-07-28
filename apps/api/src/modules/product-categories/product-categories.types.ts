/** Mirrors ProductError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ProductCategoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductCategoryError';
  }
}

export interface ProductCategoryListFilters {
  is_active?: boolean;
  search?: string;
  page: number;
  limit: number;
  sort_by?: 'name' | 'code' | 'sort_order' | 'created_at';
  sort_order?: 'asc' | 'desc';
}

export interface CreateProductCategoryData {
  code: string;
  name: string;
  description?: string;
  isActive: boolean;
  sortOrder?: number;
  createdBy: string;
}

export interface UpdateProductCategoryData {
  name?: string;
  description?: string;
  isActive?: boolean;
  sortOrder?: number;
}
