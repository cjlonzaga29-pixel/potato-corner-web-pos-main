import type { Prisma, VariantLifecycleStatus } from '@prisma/client';
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
  // CR-005 Sub-phase 3c
  lifecycleStatus?: VariantLifecycleStatus;
  createdById?: string;
}

export interface UpdateVariantData {
  name?: string;
  sizeLabel?: string;
  basePrice?: number;
  displayOrder?: number;
  isActive?: boolean;
}

// CR-005 Sub-phase 3c — variant lifecycle

export interface UpdateVariantLifecycleData {
  lifecycleStatus?: VariantLifecycleStatus;
  version?: number;
  lastChangeReason?: string | null;
  approvedById?: string | null;
  approvedAt?: Date | null;
  name?: string;
  sizeLabel?: string;
  basePrice?: number;
  vatableCapAmount?: number | null;
  displayOrder?: number;
  kcal?: number | null;
  maxFlavors?: number;
}

export interface InsertVariantChangeLogData {
  productVariantId: string;
  version: number;
  changedById: string;
  reason: string;
  snapshotJson: Prisma.InputJsonValue;
}

// CR-005 Sub-phase 3d — flavor slot CRUD

export interface AddFlavorSlotInput {
  label: string;
  flavorQty: number;
  unit: string;
  required?: boolean;
}

export interface UpdateFlavorSlotInput {
  label?: string;
  flavorQty?: number;
  unit?: string;
  required?: boolean;
}

export interface ReorderFlavorSlotsInput {
  slotIds: string[];
}

export interface FlavorSlotEditContext {
  reason?: string;
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
