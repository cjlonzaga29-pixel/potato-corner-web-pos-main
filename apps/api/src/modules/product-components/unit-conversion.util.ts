import { Prisma } from '@prisma/client';
import { universalInventoryRepository } from '../universal-inventory/universal-inventory.repository.js';

/** Thrown by convertQuantity when no UnitConversion row (direct or inverse) supports the requested conversion — deduction must fail closed, never guess. */
export class UnitConversionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnitConversionError';
  }
}

/**
 * Converts a recipe-unit quantity into `toUnitId`'s unit, Decimal-safe.
 * Same-unit is a pure copy — never queries a conversion table. Otherwise,
 * resolution follows a fixed priority (TASK 115):
 *   1. Same unit ID — identity (handled above).
 *   2. `inventoryItemId` given — an InventoryItemUnitConversion row scoped to
 *      that item (direct or its safe inverse) takes precedence, since
 *      item-specific density (e.g. tbsp -> g) overrides any global factor.
 *   3. The global UnitConversion row (direct or inverse) as fallback.
 *   4. Neither exists — throws UnitConversionError (fail closed, no implicit
 *      unit compatibility or factor is ever guessed).
 */
export async function convertQuantity(
  quantity: Prisma.Decimal | number,
  fromUnitId: string,
  toUnitId: string,
  inventoryItemId?: string,
): Promise<Prisma.Decimal> {
  const amount = new Prisma.Decimal(quantity);
  if (fromUnitId === toUnitId) return amount;

  if (inventoryItemId) {
    const itemDirect = await universalInventoryRepository.findItemConversion(inventoryItemId, fromUnitId, toUnitId);
    if (itemDirect) return amount.mul(itemDirect.factor);

    const itemInverse = await universalInventoryRepository.findItemConversion(inventoryItemId, toUnitId, fromUnitId);
    if (itemInverse) return amount.div(itemInverse.factor);
  }

  const direct = await universalInventoryRepository.findConversion(fromUnitId, toUnitId);
  if (direct) return amount.mul(direct.factor);

  const inverse = await universalInventoryRepository.findConversion(toUnitId, fromUnitId);
  if (inverse) return amount.div(inverse.factor);

  throw new UnitConversionError(
    'MISSING_UNIT_CONVERSION',
    `No UnitConversion row between unit ${fromUnitId} and ${toUnitId}`,
  );
}
