import type { InventoryStockMovementType } from '@potato-corner/shared';

/**
 * Single source of truth for human-readable movement-type labels, shared by
 * the dedicated Inventory Movements screen, the Supervisor/Branch Reports
 * tab, and the Admin Reports tab — previously each rendered the raw enum
 * string or a naive title-case that didn't lowercase the tail of
 * underscore-joined values (e.g. "ADJUSTMENT_IN" -> "ADJUSTMENT IN").
 */
export const MOVEMENT_TYPE_LABELS: Record<InventoryStockMovementType, string> = {
  RECEIVING: 'Deliveries / Received',
  ADJUSTMENT_IN: 'Adjustment (In)',
  ADJUSTMENT_OUT: 'Adjustment (Out)',
  WASTE: 'Waste',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  PHYSICAL_COUNT: 'Physical Count',
  SALE: 'Sale',
  SALE_REVERSAL: 'Sale Reversal',
};

/**
 * POS-PERF-P61 — an Extra Supplies deduction is stored as ADJUSTMENT_OUT with this
 * reference, so an older API can still read it. It must never read as a manual adjustment.
 */
export const EXTRA_SUPPLY_REFERENCE_TYPE = 'extra_supply_issue';

export function movementDisplayLabel(movement: { movement_type: InventoryStockMovementType; reference_type?: string | null }): string {
  return movement.reference_type === EXTRA_SUPPLY_REFERENCE_TYPE ? 'Extra Supply Issue' : MOVEMENT_TYPE_LABELS[movement.movement_type];
}

/** Falls back to the raw value for anything outside the known enum (defensive — report rows type movement_type as a bare string). */
export function movementTypeLabel(value: string): string {
  return MOVEMENT_TYPE_LABELS[value as InventoryStockMovementType] ?? value;
}
