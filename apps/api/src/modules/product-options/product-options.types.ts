/** Mirrors ProductError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ProductOptionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductOptionError';
  }
}

export type SelectionType = 'SINGLE' | 'MULTIPLE';

export interface OptionGroupListFilters {
  is_active?: boolean;
  search?: string;
  page: number;
  limit: number;
  sort_by?: 'name' | 'code' | 'sort_order' | 'created_at';
  sort_order?: 'asc' | 'desc';
}

export interface CreateOptionGroupData {
  code: string;
  name: string;
  description?: string;
  posButtonLabel?: string | null;
  selectionType: SelectionType;
  minSelections: number;
  maxSelections?: number;
  required: boolean;
  isActive: boolean;
  sortOrder?: number;
  createdBy: string;
}

export interface UpdateOptionGroupData {
  name?: string;
  description?: string;
  posButtonLabel?: string | null;
  selectionType?: SelectionType;
  minSelections?: number;
  maxSelections?: number | null;
  required?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

// TASK 75 — resolved (camelCase, ID-validated) inventory deduction ready to
// persist. Category/base unit are never part of this shape — they're derived
// from InventoryItem at read time, never stored on the mapping.
export interface ResolvedInventoryDeduction {
  inventoryItemId: string;
  deductionUnitId: string;
  quantityRequired: number;
}

export interface CreateOptionData {
  optionGroupId: string;
  code: string;
  name: string;
  priceAdjustment: number;
  imageUrl?: string;
  isActive: boolean;
  sortOrder?: number;
  createdBy: string;
  inventoryDeduction?: ResolvedInventoryDeduction;
}

export interface UpdateOptionData {
  name?: string;
  priceAdjustment?: number;
  imageUrl?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  // undefined = leave mapping untouched; null = delete it; object = upsert it.
  inventoryDeduction?: ResolvedInventoryDeduction | null;
}

export interface AssignVariantOptionGroupData {
  optionGroupId: string;
  required?: boolean | null;
  sortOrder?: number;
  allowedOptionIds?: string[];
  createdBy: string;
}

export interface UpdateVariantOptionGroupData {
  required?: boolean | null;
  sortOrder?: number;
  allowedOptionIds?: string[];
}
