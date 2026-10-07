import { prisma } from '../../lib/prisma.js';
import { computeBomDeduction } from '../shadow-bom-deduction/shadow-bom-deduction.service.js';
import { classifyStockStatus } from '../universal-inventory/universal-inventory.service.js';
import type { CartAvailabilityLineInput, CartAvailabilityResult, StockStatus, VariantStockResult } from './stock-availability.types.js';

interface StockRow {
  inventoryItemId: string;
  quantityOnHand: { toNumber(): number };
  quantityReserved: { toNumber(): number };
  lowStockThreshold: { toNumber(): number } | null;
  criticalThreshold: { toNumber(): number } | null;
}

/** branch-scoped InventoryStock rows for the given items, keyed by inventoryItemId — one batched query shared by every caller below. */
async function fetchStockByItem(branchId: string, inventoryItemIds: string[]): Promise<Map<string, StockRow>> {
  if (inventoryItemIds.length === 0) return new Map();
  const rows = await prisma.inventoryStock.findMany({
    where: { branchId, inventoryItemId: { in: inventoryItemIds } },
    select: { inventoryItemId: true, quantityOnHand: true, quantityReserved: true, lowStockThreshold: true, criticalThreshold: true },
  });
  return new Map(rows.map((row) => [row.inventoryItemId, row]));
}

function availableQuantity(stock: StockRow | undefined): number {
  if (!stock) return 0;
  return Math.max(0, stock.quantityOnHand.toNumber() - stock.quantityReserved.toNumber());
}

export const stockAvailabilityService = {
  /**
   * Card-level stock badge for every requested variant, scoped to the
   * variant's BASE recipe only (flavor_id IS NULL) — no flavor/option is
   * known yet at the product-card level. A variant with zero BOM components
   * (readiness already requires at least one, but this stays defensive)
   * resolves to 'unknown', never 'out_of_stock' — unknown and confirmed
   * out-of-stock must never be conflated.
   */
  async evaluateCatalogStock(branchId: string, productVariantIds: string[]): Promise<Map<string, VariantStockResult>> {
    if (productVariantIds.length === 0) return new Map();

    const linesByVariant = await Promise.all(
      productVariantIds.map(async (productVariantId) => ({
        productVariantId,
        lines: await computeBomDeduction(productVariantId, branchId, 1, null),
      })),
    );

    const allItemIds = [...new Set(linesByVariant.flatMap((v) => v.lines.map((l) => l.inventoryItemId)))];
    const stockByItem = await fetchStockByItem(branchId, allItemIds);

    const results = new Map<string, VariantStockResult>();
    for (const { productVariantId, lines } of linesByVariant) {
      results.set(productVariantId, { ...evaluateLines(lines, stockByItem), productVariantId });
    }
    return results;
  },

  /**
   * Cart-wide pre-check: sums required ingredient quantity across every line
   * in the request (the cashier's current cart plus the item/quantity about
   * to be added), so ingredients shared across different cart lines are
   * never double-counted as independently available. flavor_id overrides the
   * base recipe per-ingredient (same rule computeBomDeduction already
   * applies for the live checkout deduction); each Mix & Max slot's snack
   * variant contributes its own BOM on top of the parent variant's.
   * Read-only — the atomic reservation at checkout remains the final guard.
   */
  async evaluateCartAvailability(branchId: string, lines: CartAvailabilityLineInput[]): Promise<CartAvailabilityResult> {
    type SubLine = { productVariantId: string; flavorId: string | null; quantity: number };
    const subLines: SubLine[] = lines.flatMap((line) => {
      const parent: SubLine = { productVariantId: line.productVariantId, flavorId: line.flavorId ?? null, quantity: line.quantity };
      const slots: SubLine[] = (line.selectedFlavors ?? []).map((sf) => ({
        productVariantId: sf.snackProductVariantId,
        flavorId: sf.flavorId,
        quantity: line.quantity,
      }));
      return [parent, ...slots];
    });

    const requiredByItem = new Map<string, number>();
    const perSubLineResults = await Promise.all(
      subLines.map((sub) => computeBomDeduction(sub.productVariantId, branchId, sub.quantity, sub.flavorId)),
    );
    for (const bomLines of perSubLineResults) {
      for (const bomLine of bomLines) {
        requiredByItem.set(bomLine.inventoryItemId, (requiredByItem.get(bomLine.inventoryItemId) ?? 0) + bomLine.quantity);
      }
    }

    const itemIds = [...requiredByItem.keys()];
    if (itemIds.length === 0) return { ok: true, shortfalls: [] };

    const stockRows = await prisma.inventoryStock.findMany({
      where: { branchId, inventoryItemId: { in: itemIds } },
      select: {
        inventoryItemId: true,
        quantityOnHand: true,
        quantityReserved: true,
        lowStockThreshold: true,
        criticalThreshold: true,
        inventoryItem: { select: { name: true } },
      },
    });
    const stockByItem = new Map(stockRows.map((row) => [row.inventoryItemId, row]));

    const shortfalls = itemIds
      .map((inventoryItemId) => {
        const stock = stockByItem.get(inventoryItemId);
        const available = availableQuantity(stock);
        const required = requiredByItem.get(inventoryItemId) ?? 0;
        return {
          inventoryItemId,
          itemName: stock?.inventoryItem.name ?? 'Ingredient',
          available,
          required,
        };
      })
      .filter((row) => row.required > row.available);

    return { ok: shortfalls.length === 0, shortfalls };
  },
};

function evaluateLines(lines: { inventoryItemId: string; quantity: number }[], stockByItem: Map<string, StockRow>): VariantStockResult {
  if (lines.length === 0) {
    return { productVariantId: '', status: 'unknown', maxSellableUnits: null };
  }

  let maxUnits = Infinity;
  let anyLow = false;
  for (const line of lines) {
    const stock = stockByItem.get(line.inventoryItemId);
    const available = availableQuantity(stock);
    const sellableFromThisItem = line.quantity > 0 ? Math.floor(available / line.quantity) : Infinity;
    maxUnits = Math.min(maxUnits, sellableFromThisItem);

    const itemStatus = classifyStockStatus(available, stock?.lowStockThreshold?.toNumber() ?? null, stock?.criticalThreshold?.toNumber() ?? null);
    if (itemStatus !== 'healthy') anyLow = true;
  }
  if (!Number.isFinite(maxUnits)) maxUnits = 0;

  const status: StockStatus = maxUnits < 1 ? 'out_of_stock' : anyLow ? 'low_stock' : 'in_stock';
  return { productVariantId: '', status, maxSellableUnits: status === 'out_of_stock' ? 0 : maxUnits };
}
