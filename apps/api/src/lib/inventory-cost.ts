import { Prisma } from '@prisma/client';

/**
 * Weighted-average carrying cost blend — shared by receiving (existing
 * branch stock + a costed delivery) and transfer-in (destination branch
 * stock + incoming transferred value), since both are "combine a known
 * quantity/cost with another known quantity/cost" the same way:
 *   newAvgCost = (Q1*C1 + Q2*C2) / (Q1+Q2)
 *
 * If the existing cost is unknown (null — legacy stock that predates cost
 * capture, or the branch had zero on hand), there is no real figure to
 * blend against, so the incoming cost becomes the new average outright
 * rather than fabricating a blended number for an unpriced quantity. This
 * is also how an item's cost gets bootstrapped the first time it's ever
 * received/transferred with a cost attached.
 */
export function blendWeightedAverageCost(
  existingQuantity: Prisma.Decimal,
  existingUnitCost: Prisma.Decimal | null,
  incomingQuantity: Prisma.Decimal,
  incomingUnitCost: Prisma.Decimal,
): Prisma.Decimal {
  if (existingUnitCost === null || existingQuantity.lessThanOrEqualTo(0)) {
    return incomingUnitCost;
  }

  const existingValue = existingQuantity.mul(existingUnitCost);
  const incomingValue = incomingQuantity.mul(incomingUnitCost);
  const totalQuantity = existingQuantity.add(incomingQuantity);

  if (totalQuantity.lessThanOrEqualTo(0)) {
    return incomingUnitCost;
  }

  return existingValue.add(incomingValue).div(totalQuantity);
}
