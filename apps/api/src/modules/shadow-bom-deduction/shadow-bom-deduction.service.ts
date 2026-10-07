import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { computeDeduction } from '../product-inventory/product-inventory.service.js';
import { convertQuantity, UnitConversionError } from '../product-components/unit-conversion.util.js';
import type { DeductionLine } from '../product-inventory/product-inventory.types.js';
import { recipeReadinessService } from '../recipe-readiness/recipe-readiness.service.js';
import type { ReadinessStatus } from '../recipe-readiness/recipe-readiness.types.js';
import { shadowBomDeductionRepository } from './shadow-bom-deduction.repository.js';
import type { ActiveComponentRowBatch } from './shadow-bom-deduction.repository.js';
import type {
  BomDeductionLine,
  NormalizedLegacyLine,
  NormalizeLegacyResult,
  ShadowBomClassification,
  ShadowBomReportFilters,
} from './shadow-bom-deduction.types.js';

/**
 * CR-011.2's five critical readiness blockers -- a variant that trips any
 * one of these cannot yet be represented correctly by ProductComponent, so
 * a shadow comparison would be meaningless (or actively misleading) rather
 * than informative. NO_RECIPE and INACTIVE are deliberately *not* included:
 * a variant with genuinely zero components on both sides is a valid
 * (and interesting) MATCH/mismatch case, not a readiness failure to hide.
 */
const CRITICAL_BLOCKERS: ReadinessStatus[] = [
  'BACKFILL_CONFLICT',
  'UNRESOLVED_MAPPING',
  'INCOMPLETE_BRANCH_STOCK',
  'INVALID_COMPONENT',
  'LEGACY_FLAVOR_DEPENDENCY',
];

const QUANTITY_EPSILON = 1e-6;

/**
 * Maps every legacy ProductInventory deduction line onto its canonical
 * InventoryItem via an accepted InventoryIdentityMapping, in the item's own
 * base unit. Never throws: an unmapped or unit-incompatible ingredient
 * degrades the whole result to `ok: false` with the classification that
 * explains why (MISSING_LEGACY_MAPPING takes priority over
 * UNIT_CONVERSION_UNSUPPORTED when both occur across different lines,
 * since "we don't know what this even is" is a stronger blocker than "we
 * know what it is but can't compare units").
 */
export async function normalizeLegacyDeduction(legacyLines: DeductionLine[]): Promise<NormalizeLegacyResult> {
  const resolved = new Map<string, NormalizedLegacyLine>();
  let anyMissingMapping = false;
  let anyUnitMismatch = false;

  for (const line of legacyLines) {
    const mapping = await shadowBomDeductionRepository.findAcceptedMappingWithBaseUnit(line.ingredient_id);
    if (!mapping) {
      anyMissingMapping = true;
      continue;
    }
    // Legacy ProductInventory.unit is a free-text string, not a UnitOfMeasure
    // FK -- only directly comparable to the mapped item's base unit code if
    // they read the same. No implicit conversion is ever attempted here.
    if (mapping.baseUnitCode.trim().toLowerCase() !== line.unit.trim().toLowerCase()) {
      anyUnitMismatch = true;
      continue;
    }
    const existing = resolved.get(mapping.inventoryItemId);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      resolved.set(mapping.inventoryItemId, { inventoryItemId: mapping.inventoryItemId, baseUnitId: mapping.baseUnitId, quantity: line.quantity });
    }
  }

  if (anyMissingMapping) return { ok: false, classification: 'MISSING_LEGACY_MAPPING' };
  if (anyUnitMismatch) return { ok: false, classification: 'UNIT_CONVERSION_UNSUPPORTED' };
  return { ok: true, lines: Array.from(resolved.values()) };
}

/**
 * Pure calc (no writes): active ProductComponent rows for the variant,
 * already expressed in each InventoryItem's own base unit, scaled by
 * quantitySold. `branchId` is accepted for interface symmetry with
 * computeDeduction/normalizeLegacyDeduction and future branch-scoped BOM
 * overrides -- ProductComponent itself is branch-agnostic today (CR-007
 * §10), so it is not otherwise used.
 */
export async function computeBomDeduction(
  productVariantId: string,
  _branchId: string,
  quantitySold: number,
  flavorId?: string | null,
): Promise<BomDeductionLine[]> {
  const components = await shadowBomDeductionRepository.findActiveComponentsForVariant(productVariantId, flavorId);
  const map = new Map<string, BomDeductionLine>();
  for (const component of components) {
    // Null recipeUnitId (pre-CR-011.2 or backfill-created rows) is treated as
    // already-base-unit — no conversion attempted. convertQuantity throws
    // (fail closed) if a recorded recipe unit has no supporting
    // UnitConversion row; the caller (runShadowComparison) turns that into
    // an ERROR-classified comparison rather than a silent bad number.
    const recipeUnitId = component.recipeUnitId ?? component.baseUnitId;
    const baseQuantity = await convertQuantity(component.quantityRequired, recipeUnitId, component.baseUnitId, component.inventoryItemId);
    const quantity = baseQuantity.toNumber() * quantitySold;
    const existing = map.get(component.inventoryItemId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      map.set(component.inventoryItemId, { inventoryItemId: component.inventoryItemId, baseUnitId: component.baseUnitId, quantity });
    }
  }
  return Array.from(map.values());
}

/**
 * POS-PERF-P24R — resolves every (inventoryItem, fromUnit, toUnit) pair a
 * batch of components needs in exactly two queries (item-specific
 * conversions, then global ones), instead of convertQuantity's up-to-4
 * queries *per component*. Priority mirrors convertQuantity exactly: an
 * item-specific conversion (direct, then inverse) wins over the global
 * table (direct, then inverse); same-unit pairs never reach here (filtered
 * out by the caller before this function is built).
 */
async function buildBatchConverter(
  needs: { inventoryItemId: string; fromUnitId: string; toUnitId: string }[],
): Promise<(quantity: Prisma.Decimal, fromUnitId: string, toUnitId: string, inventoryItemId: string) => number> {
  if (needs.length === 0) {
    return (quantity) => new Prisma.Decimal(quantity).toNumber();
  }
  const itemIds = [...new Set(needs.map((n) => n.inventoryItemId))];
  const unitIds = [...new Set(needs.flatMap((n) => [n.fromUnitId, n.toUnitId]))];
  const [itemConversions, globalConversions] = await Promise.all([
    prisma.inventoryItemUnitConversion.findMany({ where: { inventoryItemId: { in: itemIds } } }),
    prisma.unitConversion.findMany({ where: { fromUnitId: { in: unitIds }, toUnitId: { in: unitIds } } }),
  ]);
  const itemMap = new Map(itemConversions.map((c) => [`${c.inventoryItemId}:${c.fromUnitId}:${c.toUnitId}`, c.factor]));
  const globalMap = new Map(globalConversions.map((c) => [`${c.fromUnitId}:${c.toUnitId}`, c.factor]));

  return (quantity, fromUnitId, toUnitId, inventoryItemId) => {
    const amount = new Prisma.Decimal(quantity);
    if (fromUnitId === toUnitId) return amount.toNumber();
    const itemDirect = itemMap.get(`${inventoryItemId}:${fromUnitId}:${toUnitId}`);
    if (itemDirect) return amount.mul(itemDirect).toNumber();
    const itemInverse = itemMap.get(`${inventoryItemId}:${toUnitId}:${fromUnitId}`);
    if (itemInverse) return amount.div(itemInverse).toNumber();
    const direct = globalMap.get(`${fromUnitId}:${toUnitId}`);
    if (direct) return amount.mul(direct).toNumber();
    const inverse = globalMap.get(`${toUnitId}:${fromUnitId}`);
    if (inverse) return amount.div(inverse).toNumber();
    throw new UnitConversionError('MISSING_UNIT_CONVERSION', `No UnitConversion row between unit ${fromUnitId} and ${toUnitId}`);
  };
}

/**
 * POS-PERF-P24R — batched counterpart to computeBomDeduction: resolves BOM
 * lines for many (productVariantId, flavorId, quantitySold) requests with a
 * fixed number of queries (one for every active component across every
 * requested variant, two for unit conversions) instead of one
 * findActiveComponentsForVariant + up to one convertQuantity *per
 * component* for every single request. Used by stockAvailabilityService,
 * which evaluates many variant/flavor combinations per catalog load or
 * cart check — never by the live checkout deduction path, which stays on
 * computeDeduction/computeBomDeduction unchanged. Same override semantics
 * as computeBomDeduction: a flavor-specific row for the same ingredient is
 * summed alongside the base row (not replaced), matching this repo's
 * existing ProductComponent data (flavor rows add ingredients, they don't
 * carry a duplicate base-ingredient override in practice) — preserved
 * as-is here rather than changed as part of this batching fix.
 */
export async function computeBomDeductionBatch(
  requests: { productVariantId: string; flavorId: string | null | undefined; quantitySold: number }[],
): Promise<BomDeductionLine[][]> {
  const variantIds = [...new Set(requests.map((r) => r.productVariantId))];
  const components: ActiveComponentRowBatch[] = await shadowBomDeductionRepository.findActiveComponentsForVariants(variantIds);

  const byVariant = new Map<string, ActiveComponentRowBatch[]>();
  for (const component of components) {
    const list = byVariant.get(component.productVariantId);
    if (list) list.push(component);
    else byVariant.set(component.productVariantId, [component]);
  }

  const conversionNeeds = components
    .map((c) => ({ inventoryItemId: c.inventoryItemId, fromUnitId: c.recipeUnitId ?? c.baseUnitId, toUnitId: c.baseUnitId }))
    .filter((n) => n.fromUnitId !== n.toUnitId);
  const convert = await buildBatchConverter(conversionNeeds);

  return requests.map(({ productVariantId, flavorId, quantitySold }) => {
    const rows = (byVariant.get(productVariantId) ?? []).filter(
      (c) => c.flavorId === null || (flavorId != null && c.flavorId === flavorId),
    );
    const map = new Map<string, BomDeductionLine>();
    for (const row of rows) {
      const fromUnitId = row.recipeUnitId ?? row.baseUnitId;
      const baseQuantity = convert(row.quantityRequired, fromUnitId, row.baseUnitId, row.inventoryItemId);
      const quantity = baseQuantity * quantitySold;
      const existing = map.get(row.inventoryItemId);
      if (existing) {
        existing.quantity += quantity;
      } else {
        map.set(row.inventoryItemId, { inventoryItemId: row.inventoryItemId, baseUnitId: row.baseUnitId, quantity });
      }
    }
    return Array.from(map.values());
  });
}

/**
 * Set + quantity comparison between the normalized legacy side and the BOM
 * side. Priority when a sale line trips more than one condition at once
 * (mirrors classifyVariant's STATUS_PRIORITY approach): an item missing
 * from the BOM side entirely is reported before an extra BOM-only item,
 * which is reported before a same-item quantity mismatch. A base-unit
 * mismatch between two lines that otherwise resolved to the same
 * InventoryItem id is defense-in-depth (should be structurally impossible
 * since both sides key off InventoryItem.baseUnitId) but is checked rather
 * than silently compared.
 */
export function compareDeductions(legacyLines: NormalizedLegacyLine[], bomLines: BomDeductionLine[]): ShadowBomClassification {
  const bomMap = new Map(bomLines.map((line) => [line.inventoryItemId, line]));
  const legacyMap = new Map(legacyLines.map((line) => [line.inventoryItemId, line]));

  if (legacyLines.some((line) => !bomMap.has(line.inventoryItemId))) return 'MISSING_BOM_COMPONENT';
  if (bomLines.some((line) => !legacyMap.has(line.inventoryItemId))) return 'EXTRA_BOM_COMPONENT';

  for (const legacy of legacyLines) {
    const bom = bomMap.get(legacy.inventoryItemId);
    if (bom && bom.baseUnitId !== legacy.baseUnitId) return 'UNIT_CONVERSION_UNSUPPORTED';
  }

  for (const legacy of legacyLines) {
    const bom = bomMap.get(legacy.inventoryItemId);
    if (bom && Math.abs(bom.quantity - legacy.quantity) > QUANTITY_EPSILON) return 'QUANTITY_MISMATCH';
  }

  return 'MATCH';
}

function sanitizeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message.slice(0, 1000), stack: (error.stack ?? '').slice(0, 4000) || null };
  }
  return { message: String(error).slice(0, 1000), stack: null };
}

/**
 * Structured, safe logging for a shadow comparison failure (the ERROR
 * classification -- an uncaught exception during comparison, not an
 * informative mismatch classification). Deliberately limited to
 * non-sensitive identifiers plus an error category derived from the
 * exception's name. Never includes customer/payment data, full exception
 * objects/stacks, secrets, or raw transaction payloads -- those live only in
 * the DB's errorDetails column (already truncated by sanitizeError), never
 * in process logs.
 */
function logShadowFailure(fields: {
  transactionId: string;
  saleLineId: string;
  branchId: string;
  productVariantId: string;
  errorCategory: string;
}): void {
  console.error('Shadow BOM comparison failed (non-blocking, sale unaffected)', fields);
}

export const shadowBomDeductionService = {
  /**
   * Orchestrator: never throws, and never writes anything but its own
   * ShadowBomComparison row (upsert, idempotent by transactionId+saleLineId).
   * Read-only with respect to every live inventory/POS table. Intended to be
   * called fire-and-forget (`.catch()`-guarded, non-awaited) after a sale's
   * legacy deduction has already committed -- see transactions.service.ts.
   */
  async runShadowComparison(transactionId: string, saleLineId: string, branchId: string, productVariantId: string, quantitySold: number): Promise<void> {
    const persist = async (fields: {
      legacyCalculation: unknown;
      bomCalculation: unknown;
      classification: ShadowBomClassification;
      errorDetails: unknown;
    }) => {
      await shadowBomDeductionRepository.upsertComparison({
        transactionId,
        saleLineId,
        branchId,
        productVariantId,
        ...fields,
      });
    };

    try {
      const readiness = await recipeReadinessService.buildReport({ productVariantId });
      const variant = readiness.variants.find((v) => v.productVariantId === productVariantId);

      if (!variant || variant.blockers.some((blocker) => CRITICAL_BLOCKERS.includes(blocker.code))) {
        await persist({
          legacyCalculation: {
            skipped: true,
            reason: 'BOM_NOT_READY',
            blockers: variant ? variant.blockers.map((b) => b.code) : ['VARIANT_NOT_FOUND'],
          },
          bomCalculation: null,
          classification: 'BOM_NOT_READY',
          errorDetails: null,
        });
        return;
      }

      // Every variant reaching this point has no LEGACY_FLAVOR_DEPENDENCY
      // blocker, i.e. no flavor-specific ProductInventory rows exist for it
      // -- flavorId is therefore irrelevant to its legacy deduction and is
      // safely omitted (base rows only).
      const legacyLinesRaw = await computeDeduction({ productVariantId, flavorId: null, quantitySold, branchId });
      const bomLines = await computeBomDeduction(productVariantId, branchId, quantitySold);
      const normalized = await normalizeLegacyDeduction(legacyLinesRaw);

      if (!normalized.ok) {
        await persist({
          legacyCalculation: legacyLinesRaw,
          bomCalculation: bomLines,
          classification: normalized.classification,
          errorDetails: null,
        });
        return;
      }

      const classification = compareDeductions(normalized.lines, bomLines);
      await persist({
        legacyCalculation: normalized.lines,
        bomCalculation: bomLines,
        classification,
        errorDetails: null,
      });
    } catch (error) {
      logShadowFailure({
        transactionId,
        saleLineId,
        branchId,
        productVariantId,
        errorCategory: error instanceof Error ? error.name : 'UnknownError',
      });
      // Absolute last resort: even the error-path persist must never throw
      // out of this function -- a DB hiccup while recording the ERROR row
      // must not become an unhandled rejection on the sale's fire-and-forget
      // shadow call.
      await persist({
        legacyCalculation: [],
        bomCalculation: null,
        classification: 'ERROR',
        errorDetails: sanitizeError(error),
      }).catch(() => {
        /* swallow -- shadow path must never throw */
      });
    }
  },

  async getSummary(filters: ShadowBomReportFilters) {
    const summary = await shadowBomDeductionRepository.buildSummary(filters);
    const matchPercentage = summary.total === 0 ? 0 : Math.round((summary.matchCount / summary.total) * 10000) / 100;
    return { ...summary, matchPercentage };
  },

  async getDetails(filters: ShadowBomReportFilters, page: number, pageSize: number) {
    return shadowBomDeductionRepository.findDetails(filters, page, pageSize);
  },
};
