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
 * Same-unit is a pure copy — never queries UnitConversion. A different unit
 * requires an exact UnitConversion row, tried direct (fromUnitId -> toUnitId,
 * multiply by factor) then its safe inverse (toUnitId -> fromUnitId, divide
 * by factor) — and throws UnitConversionError when neither exists (fail
 * closed, no implicit unit compatibility assumed).
 */
export async function convertQuantity(quantity: Prisma.Decimal | number, fromUnitId: string, toUnitId: string): Promise<Prisma.Decimal> {
  const amount = new Prisma.Decimal(quantity);
  if (fromUnitId === toUnitId) return amount;

  const direct = await universalInventoryRepository.findConversion(fromUnitId, toUnitId);
  if (direct) return amount.mul(direct.factor);

  const inverse = await universalInventoryRepository.findConversion(toUnitId, fromUnitId);
  if (inverse) return amount.div(inverse.factor);

  throw new UnitConversionError(
    'MISSING_UNIT_CONVERSION',
    `No UnitConversion row between unit ${fromUnitId} and ${toUnitId}`,
  );
}
