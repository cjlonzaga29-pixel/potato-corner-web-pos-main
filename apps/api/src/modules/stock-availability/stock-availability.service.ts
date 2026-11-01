import { prisma } from '../../lib/prisma.js';
import { convertQuantity, UnitConversionError } from '../product-components/unit-conversion.util.js';
import { buildBatchConverter, computeBomDeductionBatch, computeBomDeductionBatchSettled } from '../shadow-bom-deduction/shadow-bom-deduction.service.js';
import { productReadinessService } from '../product-readiness/product-readiness.service.js';
import { productsRepository } from '../products/products.repository.js';
import { availableStock, classifyStockStatus } from '../universal-inventory/stock-classification.js';
import { evaluateRequiredChoices, toStockChoiceRequest } from './required-choice-combinations.js';
import type { RequiredChoice, RequiredChoiceResult, StockLine } from './required-choice-combinations.js';
import type {
  BranchRecipeShortages,
  CartAvailabilityLineInput,
  CartAvailabilityResult,
  CatalogStockRequest,
  RecipeSetupIssue,
  RecipeShortage,
  RecipeShortageAffected,
  RequiredStockChoices,
  StockShortage,
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

/** Whole units this availability covers: the POS card, the cart check and the alert all use this one sum. */
function servingsFrom(available: number, perServing: number): number {
  return perServing > 0 ? Math.floor(available / perServing) : Infinity;
}

/**
 * POS-PERF-P57 — BOM lines with an unconvertible recipe as null. Readiness
 * doesn't check conversions, so one such recipe must not fail the read for
 * every other product at the branch. Checkout still refuses that recipe.
 */
async function bomLinesOrNull(requests: { productVariantId: string; flavorId: string | null; quantitySold: number }[]): Promise<(StockLine[] | null)[]> {
  try {
    return await computeBomDeductionBatch(requests);
  } catch (error) {
    if (!(error instanceof UnitConversionError)) throw error;
    return (await computeBomDeductionBatchSettled(requests)).map((result) => (result instanceof Error ? null : result));
  }
}

const roundQuantity = (value: number) => Math.round(value * 1000) / 1000;

function availableQuantity(stock: StockRow | undefined): number {
  if (!stock) return 0;
  return availableStock(stock.quantityOnHand.toNumber(), stock.quantityReserved.toNumber());
}

/** Names, units and tracking for the items actually short — one query, and only when something is out of stock. */
async function nameShortages(results: Map<string, VariantStockResult>): Promise<void> {
  const shortages = [...results.values()].flatMap((result) => result.shortages);
  if (shortages.length === 0) return;
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: [...new Set(shortages.map((s) => s.inventoryItemId))] } },
    select: { id: true, name: true, trackInventory: true, baseUnit: { select: { code: true } } },
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const shortage of shortages) {
    const item = byId.get(shortage.inventoryItemId);
    if (!item) continue;
    shortage.name = item.name;
    shortage.unitCode = item.baseUnit.code;
    shortage.trackInventory = item.trackInventory;
  }
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

    const bomLinesByRequest = (await bomLinesOrNull(flatRequests.map((r) => ({ ...r, quantitySold: 1 })))).map((lines) => lines ?? []);
    const choicesByVariant = new Map(variants.flatMap((variant) => (variant.choices ? [[variant.productVariantId, variant.choices] as const] : [])));
    const slotLines = await slotChoiceLines([...choicesByVariant.values()]);
    const pickLines = await optionServingLines([...choicesByVariant.values()].flatMap((choices) => choices.requiredPicks.flat().map((option) => option.id)));

    const allItemIds = [...new Set([...bomLinesByRequest.flat(), ...[...slotLines.values()].flat(), ...pickLines.values()].map((l) => l.inventoryItemId))];
    const stockByItem = await fetchStockByItem(branchId, allItemIds);

    const results = new Map<string, VariantStockResult>();
    let cursor = 0;
    for (const [productVariantId, subs] of subRequestsByVariant) {
      const subLines = subs.map(() => bomLinesByRequest[cursor++] ?? []);
      const aggregated = aggregateVariantStock(subLines.map((lines) => evaluateLines(lines, stockByItem)));
      const choices = choicesByVariant.get(productVariantId);
      const combined = choices
        ? evaluateVariantChoices(choices, subs.map((sub, index) => ({ flavorId: sub.flavorId, lines: subLines[index] ?? [] })), slotLines, pickLines, (itemId) => availableQuantity(stockByItem.get(itemId)))
        : null;
      // A confirmed answer from the whole selection replaces the flavor-only one. 'unknown' (no recipe) stays, unless the slots supply the recipe.
      const useCombined = combined && combined.outcome !== 'too_many' && combined.lines.length > 0 && (aggregated.status !== 'unknown' || (choices?.slots.length ?? 0) > 0);
      results.set(productVariantId, { ...(useCombined ? evaluateLines(combined.lines, stockByItem) : aggregated), productVariantId });
    }
    await nameShortages(results);
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
    for (const optionLine of await optionRequirements(lines)) {
      requiredByItem.set(optionLine.inventoryItemId, (requiredByItem.get(optionLine.inventoryItemId) ?? 0) + optionLine.quantity);
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

  /**
   * POS-PERF-P57 — which tracked items can't cover one serving of what the POS
   * offers at this branch, by the same recipe, conversion, flavor and
   * availability rules as evaluateCatalogStock. A fixed number of batched
   * queries, however many products there are.
   *
   * Flavors and add-ons are alternatives, so each configuration is judged on
   * its own quantity and quantities are never added across them: an item is
   * reported for the sizes and choices it actually can't cover, and blocksSize
   * says whether anything of that size can still be sold. Choices one sale
   * takes together (Mix & Max slots, required add-ons) do add up, so a size is
   * blocked only when no whole selection fits.
   *
   * Only sellable variants are read. A size with a setup problem or a product
   * a supervisor turned off is not a shortage. An item with no stock row here,
   * or an untracked item a recipe still needs, blocks the POS too, but more
   * stock on a dashboard list would not explain it, so those are setupIssues.
   */
  async evaluateBranchRecipeShortages(branchId: string): Promise<BranchRecipeShortages> {
    const [products, disabledFlavorIds] = await Promise.all([
      productsRepository.findRecipeCheckCatalogForBranch(branchId),
      productsRepository.findDisabledFlavorIds(branchId),
    ]);
    const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
    if (variantIds.length === 0) return { byItem: new Map(), setupIssues: [] };

    const readiness = await productReadinessService.evaluateProductVariantReadinessBatch({ branchId, productVariantIds: variantIds });
    const sellable = new Set(readiness.filter((result) => result.sellable).map((result) => result.productVariantId));
    const disabledFlavors = new Set(disabledFlavorIds);

    interface Configuration {
      flavorName: string | null;
      lines: { inventoryItemId: string; quantity: number }[];
    }
    const variants = products.flatMap((product) =>
      product.variants
        .filter((variant) => sellable.has(variant.id))
        .map((variant) => {
          const request = toStockChoiceRequest(variant, disabledFlavors);
          return {
            product,
            variant,
            choices: request.choices,
            flavors: variant.variantFlavors.filter((vf) => request.flavorIds.includes(vf.flavorId)),
          };
        }),
    );
    const requests = variants.flatMap(({ variant, flavors }) =>
      (flavors.length > 0 ? flavors.map((vf): string | null => vf.flavorId) : [null]).map((flavorId) => ({ productVariantId: variant.id, flavorId, quantitySold: 1 })),
    );
    const bomLines = await bomLinesOrNull(requests);
    const optionLines = await optionServingLines(
      variants.flatMap(({ variant }) =>
        variant.optionGroupAssignments.flatMap((assignment) => [...assignment.allowedOptions.map((row) => row.productOption.id), ...assignment.optionGroup.options.map((option) => option.id)]),
      ),
    );
    const slotLines = await slotChoiceLines(variants.flatMap(({ choices }) => (choices ? [choices] : [])));

    const itemIds = [...new Set([...bomLines.flatMap((lines) => lines ?? []), ...[...slotLines.values()].flat(), ...optionLines.values()].map((line) => line.inventoryItemId))];
    const [stockByItem, items] = await Promise.all([
      fetchStockByItem(branchId, itemIds),
      prisma.inventoryItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, name: true, trackInventory: true, baseUnit: { select: { code: true } } },
      }),
    ]);
    const itemById = new Map(items.map((item) => [item.id, item]));

    const affectedByItem = new Map<string, RecipeShortageAffected[]>();
    const setupIssues = new Map<string, RecipeSetupIssue>();
    const availableOf = (inventoryItemId: string) => availableQuantity(stockByItem.get(inventoryItemId));
    const isShort = (inventoryItemId: string, quantity: number) => servingsFrom(availableOf(inventoryItemId), quantity) < 1;
    /** Tracked item with a stock row: a shortage. Anything else that blocks is setup, recorded once per item and size. */
    const reportable = (inventoryItemId: string, productName: string, variantName: string): boolean => {
      const item = itemById.get(inventoryItemId);
      if (!item) return false;
      const reason = !stockByItem.has(inventoryItemId) ? ('not_assigned' as const) : !item.trackInventory ? ('untracked' as const) : null;
      if (!reason) return true;
      setupIssues.set(`${inventoryItemId}:${productName}:${variantName}`, { inventoryItemId, name: item.name, reason, productName, variantName });
      return false;
    };
    const addAffected = (inventoryItemId: string, entry: RecipeShortageAffected) => {
      const list = affectedByItem.get(inventoryItemId);
      if (list) list.push(entry);
      else affectedByItem.set(inventoryItemId, [entry]);
    };

    let cursor = 0;
    for (const { product, variant, flavors, choices } of variants) {
      const flavorLines = (flavors.length > 0 ? flavors : [null]).map((flavor) => {
        const lines = bomLines[cursor++];
        return { flavor, lines: lines ?? [], unconvertible: lines === null };
      });
      if (flavorLines.some((entry) => entry.unconvertible)) {
        setupIssues.set(`unit:${variant.id}`, { inventoryItemId: null, name: 'Its recipe', reason: 'no_unit_conversion', productName: product.name, variantName: variant.name });
      }
      const configurations: Configuration[] = flavorLines.map(({ flavor, lines }) => ({ flavorName: flavor?.flavor.name ?? null, lines }));
      const base = { productId: product.id, productName: product.name, variantId: variant.id, variantName: variant.name };
      const combined = choices
        ? evaluateVariantChoices(choices, flavorLines.map(({ flavor, lines }) => ({ flavorId: flavor?.flavorId ?? null, lines })), slotLines, optionLines, availableOf)
        : null;
      const nothingSells = combined?.outcome === 'blocked' || configurations.every((config) => config.lines.some((line) => isShort(line.inventoryItemId, line.quantity)));
      for (const slot of choices?.slots ?? []) {
        if (slot.options.some((option) => option.flavors.some((flavor) => slotLines.has(slotLineKey(option.productVariantId, flavor.flavorId))))) continue;
        setupIssues.set(`slot:${variant.id}:${slot.label}`, { inventoryItemId: null, name: slot.label, reason: 'no_slot_choice', productName: product.name, variantName: variant.name });
      }

      const perItem = new Map<string, { config: Configuration; quantity: number }[]>();
      for (const config of configurations) {
        for (const line of config.lines) {
          if (!isShort(line.inventoryItemId, line.quantity)) continue;
          const list = perItem.get(line.inventoryItemId);
          if (list) list.push({ config, quantity: line.quantity });
          else perItem.set(line.inventoryItemId, [{ config, quantity: line.quantity }]);
        }
      }
      for (const [inventoryItemId, shortIn] of perItem) {
        if (!reportable(inventoryItemId, product.name, variant.name)) continue;
        const available = availableQuantity(stockByItem.get(inventoryItemId));
        const firstQuantity = shortIn[0]?.quantity ?? 0;
        const everyConfigurationSame = shortIn.length === configurations.length && shortIn.every((entry) => entry.quantity === firstQuantity);
        const entries = everyConfigurationSame ? [{ choiceName: null, quantity: firstQuantity }] : shortIn.map((entry) => ({ choiceName: entry.config.flavorName, quantity: entry.quantity }));
        for (const { choiceName, quantity } of entries) {
          addAffected(inventoryItemId, {
            ...base,
            choiceName,
            choiceKind: choiceName === null ? null : 'flavor',
            required: roundQuantity(quantity),
            deficit: roundQuantity(quantity - available),
            blocksSize: nothingSells,
          });
        }
      }

      // A selection no whole combination can cover names what would have to be
      // restocked: the items short in the combination closest to fitting.
      const reported = new Set(perItem.keys());
      if (combined?.outcome === 'blocked') {
        for (const line of combined.short) {
          if (reported.has(line.inventoryItemId) || !reportable(line.inventoryItemId, product.name, variant.name)) continue;
          reported.add(line.inventoryItemId);
          addAffected(line.inventoryItemId, {
            ...base,
            choiceName: combined.names.join(' + ') || null,
            choiceKind: 'combination',
            required: roundQuantity(line.quantity),
            deficit: roundQuantity(line.quantity - availableOf(line.inventoryItemId)),
            blocksSize: true,
          });
        }
      } else {
        // A slot option too big by itself, while something else still fills the slot.
        const fixedLines = configurations[0]?.lines ?? [];
        for (const slot of choices?.slots ?? []) {
          for (const option of slot.options) {
            const shortFlavors = new Map<string, { quantity: number; flavorNames: string[] }>();
            for (const flavor of option.flavors) {
              for (const line of slotLines.get(slotLineKey(option.productVariantId, flavor.flavorId)) ?? []) {
                const quantity = line.quantity + (fixedLines.find((fixed) => fixed.inventoryItemId === line.inventoryItemId)?.quantity ?? 0);
                if (!isShort(line.inventoryItemId, quantity)) continue;
                const key = `${line.inventoryItemId}:${quantity}`;
                const entry = shortFlavors.get(key) ?? { quantity, flavorNames: [] };
                entry.flavorNames.push(flavor.name);
                shortFlavors.set(key, entry);
              }
            }
            for (const [key, { quantity, flavorNames }] of shortFlavors) {
              const inventoryItemId = key.slice(0, key.lastIndexOf(':'));
              if (!reportable(inventoryItemId, product.name, variant.name)) continue;
              const everyFlavor = flavorNames.length === option.flavors.length;
              addAffected(inventoryItemId, {
                ...base,
                choiceName: `${slot.label}: ${option.name}${everyFlavor ? '' : ` (${flavorNames.join(', ')})`}`,
                choiceKind: 'slot',
                required: roundQuantity(quantity),
                deficit: roundQuantity(quantity - availableOf(inventoryItemId)),
                blocksSize: false,
              });
            }
          }
        }
      }

      // An add-on too big by itself. Whether that stops the size is the
      // selection check's answer above, under checkout's own picking rules.
      for (const assignment of variant.optionGroupAssignments) {
        const group = assignment.optionGroup;
        if (!group.isActive) continue;
        const allowed = assignment.allowedOptions.map((row) => row.productOption).filter((option) => option.isActive);
        const options = allowed.length > 0 ? allowed : group.options;
        const shortOptions = options.filter((option) => {
          const line = optionLines.get(option.id);
          return line !== undefined && isShort(line.inventoryItemId, line.quantity);
        });
        for (const option of shortOptions) {
          const line = optionLines.get(option.id);
          if (!line || !reportable(line.inventoryItemId, product.name, variant.name)) continue;
          const available = availableQuantity(stockByItem.get(line.inventoryItemId));
          addAffected(line.inventoryItemId, {
            ...base,
            choiceName: option.name,
            choiceKind: 'option',
            required: roundQuantity(line.quantity),
            deficit: roundQuantity(line.quantity - available),
            blocksSize: nothingSells,
          });
        }
      }
    }

    const byItem = new Map<string, RecipeShortage>();
    for (const [inventoryItemId, affected] of affectedByItem) {
      const required = Math.max(...affected.map((entry) => entry.required));
      byItem.set(inventoryItemId, {
        required,
        deficit: roundQuantity(required - availableQuantity(stockByItem.get(inventoryItemId))),
        unitCode: itemById.get(inventoryItemId)?.baseUnit.code ?? '',
        affected,
      });
    }
    return { byItem, setupIssues: [...setupIssues.values()] };
  },
};

/**
 * POS-PERF-P57 — one serving of each add-on the given variants offer, keyed by
 * option id, in the item's base unit: what checkout's add-on deduction takes.
 * A mapping checkout would refuse (deleted item, no unit conversion) is left
 * out, as in optionRequirements below. An option listed twice counts once here
 * because this is one selection of it, not a cart.
 */
async function optionServingLines(ids: string[]): Promise<Map<string, { inventoryItemId: string; quantity: number }>> {
  const optionIds = [...new Set(ids)];
  if (optionIds.length === 0) return new Map();
  const mappings = await prisma.productOptionInventoryMapping.findMany({
    where: { productOptionId: { in: optionIds } },
    select: { productOptionId: true, inventoryItemId: true, quantityRequired: true, deductionUnitId: true, inventoryItem: { select: { baseUnitId: true, deletedAt: true } } },
  });
  const live = mappings.filter((mapping) => mapping.inventoryItem.deletedAt === null);
  const convert = await buildBatchConverter(
    live.filter((mapping) => mapping.deductionUnitId !== mapping.inventoryItem.baseUnitId).map((mapping) => ({ inventoryItemId: mapping.inventoryItemId, fromUnitId: mapping.deductionUnitId, toUnitId: mapping.inventoryItem.baseUnitId })),
  );
  const lines = new Map<string, { inventoryItemId: string; quantity: number }>();
  for (const mapping of live) {
    try {
      lines.set(mapping.productOptionId, {
        inventoryItemId: mapping.inventoryItemId,
        quantity: convert(mapping.quantityRequired, mapping.deductionUnitId, mapping.inventoryItem.baseUnitId, mapping.inventoryItemId),
      });
    } catch {
      continue;
    }
  }
  return lines;
}

/**
 * POS-PERF-P41 — add-on ingredient requirements, the same composition
 * checkout's computeOptionDeductionLines deducts (one mapping per option,
 * converted into the item's base unit, times the line quantity; an option
 * listed twice counts twice). One query for every option in the cart. A
 * mapping checkout would refuse (inactive item, no unit conversion) is left
 * out here rather than failing the pre-check — checkout reports it.
 */
async function optionRequirements(lines: CartAvailabilityLineInput[]): Promise<{ inventoryItemId: string; quantity: number }[]> {
  const optionIds = [...new Set(lines.flatMap((line) => line.selectedOptionIds ?? []))];
  if (optionIds.length === 0) return [];
  const mappings = await prisma.productOptionInventoryMapping.findMany({
    where: { productOptionId: { in: optionIds } },
    select: { productOptionId: true, inventoryItemId: true, quantityRequired: true, deductionUnitId: true, inventoryItem: { select: { baseUnitId: true, deletedAt: true } } },
  });
  const perUnitByOption = new Map<string, { inventoryItemId: string; quantity: number }>();
  for (const mapping of mappings) {
    if (mapping.inventoryItem.deletedAt !== null) continue;
    try {
      const base = await convertQuantity(mapping.quantityRequired, mapping.deductionUnitId, mapping.inventoryItem.baseUnitId, mapping.inventoryItemId);
      perUnitByOption.set(mapping.productOptionId, { inventoryItemId: mapping.inventoryItemId, quantity: base.toNumber() });
    } catch {
      continue;
    }
  }
  return lines.flatMap((line) =>
    (line.selectedOptionIds ?? []).flatMap((optionId) => {
      const perUnit = perUnitByOption.get(optionId);
      return perUnit ? [{ inventoryItemId: perUnit.inventoryItemId, quantity: perUnit.quantity * line.quantity }] : [];
    }),
  );
}

const slotLineKey = (productVariantId: string, flavorId: string) => `${productVariantId}:${flavorId}`;

/**
 * One serving of each slot's snack and flavor, in one batched read: base recipe
 * plus flavor rows, the same lines the cart check adds up. A recipe that can't
 * be converted is left out, as checkout could not sell it either.
 */
async function slotChoiceLines(allChoices: RequiredStockChoices[]): Promise<Map<string, StockLine[]>> {
  const requests = new Map<string, { productVariantId: string; flavorId: string; quantitySold: number }>();
  for (const slot of allChoices.flatMap((choices) => choices.slots)) {
    for (const option of slot.options) {
      for (const { flavorId } of option.flavors) requests.set(slotLineKey(option.productVariantId, flavorId), { productVariantId: option.productVariantId, flavorId, quantitySold: 1 });
    }
  }
  if (requests.size === 0) return new Map();
  const results = await computeBomDeductionBatchSettled([...requests.values()]);
  const lines = new Map<string, StockLine[]>();
  [...requests.keys()].forEach((key, index) => {
    const result = results[index];
    if (result && !(result instanceof Error)) lines.set(key, result);
  });
  return lines;
}

/**
 * One variant's whole selection through the combination check. A slot with
 * nothing to choose is setup, which stock can't answer, so it reports no
 * outcome ('too_many', the same "claim nothing" answer as an oversized search).
 */
function evaluateVariantChoices(
  choices: RequiredStockChoices,
  flavorLines: { flavorId: string | null; lines: StockLine[] }[],
  slotLines: Map<string, StockLine[]>,
  pickLines: Map<string, StockLine>,
  availableOf: (inventoryItemId: string) => number,
): RequiredChoiceResult {
  const slotGroups: RequiredChoice[][] = choices.slots.map((slot) =>
    slot.options.flatMap((option) =>
      option.flavors.flatMap((flavor) => {
        const lines = slotLines.get(slotLineKey(option.productVariantId, flavor.flavorId));
        return lines ? [{ name: `${option.name} ${flavor.name}`, lines }] : [];
      }),
    ),
  );
  if (slotGroups.some((group) => group.length === 0)) return { outcome: 'too_many' };

  const flavorGroup: RequiredChoice[] = flavorLines.flatMap((entry) => (entry.flavorId === null ? [] : [{ name: choices.flavorNames.get(entry.flavorId) ?? '', lines: entry.lines }]));
  const fixedLines = flavorGroup.length === 0 ? (flavorLines[0]?.lines ?? []) : [];
  const pickGroups: RequiredChoice[][] = choices.requiredPicks.map((options) =>
    options.map((option) => {
      const line = pickLines.get(option.id);
      return { name: option.name, lines: line ? [line] : [] };
    }),
  );
  return evaluateRequiredChoices(fixedLines, [...(flavorGroup.length > 0 ? [flavorGroup] : []), ...slotGroups, ...pickGroups], availableOf);
}

function evaluateLines(lines: { inventoryItemId: string; quantity: number }[], stockByItem: Map<string, StockRow>): VariantStockResult {
  if (lines.length === 0) {
    return { productVariantId: '', status: 'unknown', maxSellableUnits: null, shortages: [] };
  }

  let maxUnits = Infinity;
  let anyLow = false;
  const shortages: StockShortage[] = [];
  for (const line of lines) {
    const stock = stockByItem.get(line.inventoryItemId);
    const available = availableQuantity(stock);
    const sellableFromThisItem = servingsFrom(available, line.quantity);
    maxUnits = Math.min(maxUnits, sellableFromThisItem);
    if (sellableFromThisItem < 1) shortages.push(toShortage(line, stock, available));

    const itemStatus = classifyStockStatus(available, stock?.lowStockThreshold?.toNumber() ?? null, stock?.criticalThreshold?.toNumber() ?? null);
    if (itemStatus !== 'healthy') anyLow = true;
  }
  if (!Number.isFinite(maxUnits)) maxUnits = 0;

  const status: StockStatus = maxUnits < 1 ? 'out_of_stock' : anyLow ? 'low_stock' : 'in_stock';
  return { productVariantId: '', status, maxSellableUnits: status === 'out_of_stock' ? 0 : maxUnits, shortages };
}

function toShortage(line: { inventoryItemId: string; quantity: number }, stock: StockRow | undefined, available: number): StockShortage {
  const onHand = stock?.quantityOnHand.toNumber() ?? 0;
  const reason: StockShortage['reason'] = !stock ? 'not_assigned' : onHand <= 0 ? 'no_stock' : available <= 0 ? 'fully_reserved' : 'below_recipe_quantity';
  // name/unit/tracking are filled in by nameShortages, once per catalog read.
  return { inventoryItemId: line.inventoryItemId, name: 'Ingredient', reason, available, required: line.quantity, unitCode: null, trackInventory: true };
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
function aggregateVariantStock(subResults: Omit<VariantStockResult, 'productVariantId'>[]): Omit<VariantStockResult, 'productVariantId'> {
  const sellable = subResults.filter((r) => r.status === 'in_stock' || r.status === 'low_stock');
  if (sellable.length > 0) {
    const anyInStock = sellable.some((r) => r.status === 'in_stock');
    const maxUnits = Math.max(...sellable.map((r) => r.maxSellableUnits ?? 0));
    return { status: anyInStock ? 'in_stock' : 'low_stock', maxSellableUnits: maxUnits, shortages: [] };
  }
  if (subResults.some((r) => r.status === 'unknown')) {
    return { status: 'unknown', maxSellableUnits: null, shortages: [] };
  }
  const byItem = new Map<string, StockShortage>();
  for (const shortage of subResults.flatMap((r) => r.shortages)) {
    if (!byItem.has(shortage.inventoryItemId)) byItem.set(shortage.inventoryItemId, shortage);
  }
  return { status: 'out_of_stock', maxSellableUnits: 0, shortages: [...byItem.values()] };
}
