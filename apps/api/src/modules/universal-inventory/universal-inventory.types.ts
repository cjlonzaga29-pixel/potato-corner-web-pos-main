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

export interface CreateInventoryItemUnitConversionData {
  inventoryItemId: string;
  fromUnitId: string;
  toUnitId: string;
  factor: number;
}

export interface UpdateInventoryItemUnitConversionData {
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

export type InventoryStockMovementType =
  | 'RECEIVING'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'WASTE'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'PHYSICAL_COUNT'
  | 'SALE'
  | 'SALE_REVERSAL';

export interface ReceiveInventoryStockData {
  branchId: string;
  inventoryItemId: string;
  quantity: number;
  enteredUnitId?: string;
  deliveryReference?: string;
  notes?: string;
  performedByUserId?: string;
}

export interface AdjustInventoryStockData {
  branchId: string;
  inventoryItemId: string;
  quantityDelta: number;
  reasonCode: string;
  notes?: string;
  performedByUserId?: string;
}

export interface WasteInventoryStockData {
  branchId: string;
  inventoryItemId: string;
  quantity: number;
  enteredUnitId?: string;
  reasonCode: string;
  notes?: string;
  performedByUserId?: string;
}

export interface TransferInventoryStockData {
  fromBranchId: string;
  toBranchId: string;
  inventoryItemId: string;
  quantity: number;
  notes?: string;
  performedByUserId?: string;
}

export interface PhysicalCountInventoryStockData {
  branchId: string;
  counts: { inventoryItemId: string; countedQuantity: number }[];
  notes?: string;
  performedByUserId?: string;
}
