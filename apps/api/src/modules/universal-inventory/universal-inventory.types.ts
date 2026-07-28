/** Mirrors ProductInventoryError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class UniversalInventoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'UniversalInventoryError';
  }
}

export interface CreateInventoryCategoryData {
  name: string;
  code?: string;
  description?: string;
}

export interface UpdateInventoryCategoryData {
  name?: string;
  code?: string;
  description?: string;
  isActive?: boolean;
}

export interface CreateUnitOfMeasureData {
  code: string;
  name: string;
  dimension: 'WEIGHT' | 'VOLUME' | 'COUNT';
  isBaseUnit?: boolean;
}

export interface UpdateUnitOfMeasureData {
  name?: string;
  isActive?: boolean;
}

export interface CreateUnitConversionData {
  fromUnitId: string;
  toUnitId: string;
  factor: number;
}

export interface CreateInventoryItemData {
  name: string;
  sku?: string;
  barcode?: string;
  categoryId?: string;
  baseUnitId: string;
  trackInventory?: boolean;
}

export interface UpdateInventoryItemData {
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  categoryId?: string | null;
  trackInventory?: boolean;
}
