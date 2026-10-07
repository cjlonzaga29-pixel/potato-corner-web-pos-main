import { prisma } from '../../lib/prisma.js';
import { computeBomDeductionBatch } from '../shadow-bom-deduction/shadow-bom-deduction.service.js';
import { classifyStockStatus } from '../universal-inventory/universal-inventory.service.js';
import type {
  CartAvailabilityLineInput,
  CartAvailabilityResult,
  CatalogStockRequest,
  StockStatus,
  VariantStockResult,
} from './stock-availability.types.js';

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
   * Card-level stock badge for every requested variant. POS-PERF-P24R — a
   * variant with flavors is checked per-flavor (base recipe + that flavor's
   * override), not just the base recipe in isolation: "out of stock" means
   * no supported sellable configuration remains, so a shortfall on the base
   * recipe must not block a variant where a specific flavor's override
   * avoids the short ingredient entirely. A flavorless variant keeps the
   * single base-recipe check. A variant with zero BOM components anywhere
   * resolves to 'unknown', never 'out_of_stock' — unknown and confirmed
   * out-of-stock must never be conflated.
   *
   * Every (variant, flavor) combination's BOM is resolved through one
   * batched call (fixed query count) rather than one findMany + per-component
   * unit-conversion lookup per combination — see computeBomDeductionBatch.
   */
  async evaluateCatalogStock(branchId: string, variants: CatalogStockRequest[]): Promise<Map<string, VariantStockResult>> {
    if (variants.length === 0) return new Map();

    type SubRequest = { productVariantId: string; flavorId: string | null };
    const subRequestsByVariant = new Map<string, SubRequest[]>();
    const flatRequests: SubRequest[] = [];
    for (const { productVariantId, flavorIds } of variants) {
      const subs: SubRequest[] = flavorIds.length > 0 ? flavorIds.map((flavorId) => ({ productVariantId, flavorId })) : [{ productVariantId, flavorId: null }];
      subRequestsByVariant.set(productVariantId, subs);
      flatRequests.push(...subs);
    }

    const bomLinesByRequest = await computeBomDeductionBatch(flatRequests.map((r) => ({ ...r, quantitySold: 1 })));

    const allItemIds = [...new Set(bomLinesByRequest.flat().map((l) => l.inventoryItemId))];
    const stockByItem = await fetchStockByItem(branchId, allItemIds);

    const results = new Map<string, VariantStockResult>();
    let cursor = 0;
    for (const [productVariantId, subs] of subRequestsByVariant) {
      const subResults = subs.map(() => evaluateLines(bomLinesByRequest[cursor++] ?? [], stockByItem));
      results.set(productVariantId, { ...aggregateVariantStock(subResults), productVariantId });
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
   *
   * POS-PERF-P24R — every sub-line's BOM is resolved through one batched
   * call (computeBomDeductionBatch) instead of one findActiveComponentsForVariant
   * + per-component conversion lookup per sub-line, so a cart with many
   * Mix & Max slots doesn't scale its query count with line count.
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
    const perSubLineResults = await computeBomDeductionBatch(
      subLines.map((sub) => ({ productVariantId: sub.productVariantId, flavorId: sub.flavorId, quantitySold: sub.quantity })),
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

/**
 * POS-PERF-P24R — a variant is only 'out_of_stock' when NONE of its
 * sellable configurations (the base recipe alone, or each flavor's
 * override on top of it) can sell even one unit. If any configuration can
 * still sell, the variant stays sellable at the card level — a cashier
 * picks the flavor in the next step, where evaluateCartAvailability's
 * per-flavor check (and the server-side atomic reservation at checkout)
 * remain the real guards. 'unknown' only wins over 'out_of_stock' when at
 * least one configuration's status couldn't be determined at all (no BOM
 * lines) and none is confirmed sellable — it must never be reported as
 * sellable itself.
 */
function aggregateVariantStock(subResults: Pick<VariantStockResult, 'status' | 'maxSellableUnits'>[]): Pick<VariantStockResult, 'status' | 'maxSellableUnits'> {
  const sellable = subResults.filter((r) => r.status === 'in_stock' || r.status === 'low_stock');
  if (sellable.length > 0) {
    const anyInStock = sellable.some((r) => r.status === 'in_stock');
    const maxUnits = Math.max(...sellable.map((r) => r.maxSellableUnits ?? 0));
    return { status: anyInStock ? 'in_stock' : 'low_stock', maxSellableUnits: maxUnits };
  }
  if (subResults.some((r) => r.status === 'unknown')) {
    return { status: 'unknown', maxSellableUnits: null };
  }
  return { status: 'out_of_stock', maxSellableUnits: 0 };
}
