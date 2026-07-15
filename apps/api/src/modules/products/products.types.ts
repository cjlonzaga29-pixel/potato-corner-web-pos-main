import type { ProductStatus } from '@potato-corner/shared';

export interface ProductListFilters {
  status?: ProductStatus;
  category?: string;
  search?: string;
  is_seasonal?: boolean;
  page: number;
  limit: number;
  sort_by?: 'name' | 'created_at' | 'updated_at' | 'display_order' | 'status';
  sort_order?: 'asc' | 'desc';
}

export interface CreateProductData {
  name: string;
  description?: string;
  category?: string;
  status: ProductStatus;
  displayOrder?: number;
  isSeasonal: boolean;
  seasonalStartDate?: string;
  seasonalEndDate?: string;
  imageUrl?: string;
  branchExclusive: boolean;
  exclusiveBranchId?: string;
}

export interface UpdateProductData {
  name?: string;
  description?: string;
  category?: string;
  displayOrder?: number;
  isSeasonal?: boolean;
  seasonalStartDate?: string | null;
  seasonalEndDate?: string | null;
  imageUrl?: string | null;
}

export interface CreateVariantData {
  name: string;
  sizeLabel: string;
  basePrice: number;
  displayOrder?: number;
  isActive: boolean;
}

export interface UpdateVariantData {
  name?: string;
  sizeLabel?: string;
  basePrice?: number;
  displayOrder?: number;
  isActive?: boolean;
}

/** Mirrors auth.types.ts's AuthError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ProductError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductError';
  }
}
