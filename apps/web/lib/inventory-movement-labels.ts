import type { InventoryStockMovementType } from '@potato-corner/shared';

/**
 * Single source of truth for human-readable movement-type labels, shared by
 * the dedicated Inventory Movements screen, the Supervisor/Branch Reports
 * tab, and the Admin Reports tab — previously each rendered the raw enum
 * string or a naive title-case that didn't lowercase the tail of
 * underscore-joined values (e.g. "ADJUSTMENT_IN" -> "ADJUSTMENT IN").
 */
export const MOVEMENT_TYPE_LABELS: Record<InventoryStockMovementType, string> = {
  RECEIVING: 'Receiving',
  ADJUSTMENT_IN: 'Adjustment (In)',
  ADJUSTMENT_OUT: 'Adjustment (Out)',
  WASTE: 'Waste',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  PHYSICAL_COUNT: 'Physical Count',
  SALE: 'Sale',
  SALE_REVERSAL: 'Sale Reversal',
};

/** Falls back to the raw value for anything outside the known enum (defensive — report rows type movement_type as a bare string). */
export function movementTypeLabel(value: string): string {
  return MOVEMENT_TYPE_LABELS[value as InventoryStockMovementType] ?? value;
}
