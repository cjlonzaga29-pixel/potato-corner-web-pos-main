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

/**
 * POS-PERF-P27 — view-level groupings over InventoryStockMovementType, used
 * only to filter branch-facing history screens server-side. Admin/
 * Supervisor's full ledger view never sends a category and is unaffected.
 *
 * POS-PERF-P31 — stock_in/waste/transfers added for the Stock History page's
 * "Stock Changes" tab filter (All / Stock In / Adjustments / Waste /
 * Transfers / Orders). order_deductions/adjustments are unchanged from their
 * original meaning (Order Deductions page / Stock Adjustments history) —
 * Stock History reuses them as-is for its own "Orders"/"Adjustments"
 * filters rather than redefining them. PHYSICAL_COUNT has no dedicated
 * bucket (not in the brief's named filter list) and only ever appears under
 * "All".
 */
export type InventoryStockMovementCategory = 'order_deductions' | 'adjustments' | 'stock_in' | 'waste' | 'transfers';

export const STOCK_MOVEMENT_CATEGORY_TYPES: Record<InventoryStockMovementCategory, InventoryStockMovementType[]> = {
  order_deductions: ['SALE', 'SALE_REVERSAL'],
  adjustments: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'],
  stock_in: ['RECEIVING'],
  waste: ['WASTE'],
  transfers: ['TRANSFER_IN', 'TRANSFER_OUT'],
};

export type InventoryProofType = 'live_capture' | 'gallery_upload';

export interface ReceiveInventoryStockData {
  branchId: string;
  inventoryItemId: string;
  quantity: number;
  /** Total peso cost for this delivery, as printed on the receipt — replaces the former per-unit unitCost input (Receiving Simplification V2). Per-base-unit carrying cost is derived server-side. Optional (P1 cost UI retirement): omitted means no cost is recorded for this delivery. */
  totalCost?: number;
  enteredUnitId?: string;
  deliveryReference?: string;
  notes?: string;
  performedByUserId?: string;
  /** POS-PERF-P29 — supervisor/admin direct-record path only; see schema.prisma's InventoryStockMovement doc comment. */
  recordedAsSupervisorDirect?: boolean;
  responsibleStaffName?: string;
  pinVerifiedAt?: Date;
  proofKey?: string;
  proofType?: InventoryProofType;
}

export interface AdjustInventoryStockData {
  branchId: string;
  inventoryItemId: string;
  quantityDelta: number;
  reasonCode: string;
  notes?: string;
  performedByUserId?: string;
  recordedAsSupervisorDirect?: boolean;
  responsibleStaffName?: string;
  pinVerifiedAt?: Date;
  proofKey?: string;
  proofType?: InventoryProofType;
}

export interface WasteInventoryStockData {
  branchId: string;
  inventoryItemId: string;
  quantity: number;
  enteredUnitId?: string;
  reasonCode: string;
  /** Accountable staff member for this waste — must be an active user assigned to branchId. Distinct from performedByUserId ("recorded by"). POS-PERF-P33: optional now that inventory-PIN identification is no longer required for supervisor/admin direct writes — a free-text "Staff Involved" name (responsibleStaffName) replaces it when no PIN-resolved user id exists. */
  responsibleUserId?: string;
  notes?: string;
  performedByUserId?: string;
  /** POS-PERF-P29 — supervisor/admin direct-record path only; see schema.prisma's InventoryStockMovement doc comment. */
  recordedAsSupervisorDirect?: boolean;
  responsibleStaffName?: string;
  pinVerifiedAt?: Date;
  proofKey?: string;
  proofType?: InventoryProofType;
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

export interface CreateInventoryCostCorrectionData {
  branchId: string;
  inventoryItemId: string;
  newUnitCost: number;
  reasonCode: string;
  notes?: string;
}
