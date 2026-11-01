import { isAddOnsOptionGroup } from '@potato-corner/shared';
import type { CatalogStockRequest } from './stock-availability.types.js';

export interface StockLine {
  inventoryItemId: string;
  quantity: number;
}

export interface RequiredChoice {
  name: string;
  lines: StockLine[];
}

export type RequiredChoiceResult =
  | { outcome: 'sellable'; maxUnits: number; lines: StockLine[] }
  | { outcome: 'blocked'; names: string[]; lines: StockLine[]; short: StockLine[] }
  | { outcome: 'too_many' };

/** Far more than any real menu after identical choices collapse. Past it nothing is claimed, so a size is never called short on a partial search. */
const MAX_COMBINATIONS = 5000;

function mergeLines(...lineSets: StockLine[][]): StockLine[] {
  const quantities = new Map<string, number>();
  for (const lines of lineSets) {
    for (const line of lines) quantities.set(line.inventoryItemId, (quantities.get(line.inventoryItemId) ?? 0) + line.quantity);
  }
  return [...quantities].map(([inventoryItemId, quantity]) => ({ inventoryItemId, quantity }));
}

/** Choices that use exactly the same stock can't change the answer, so one stands for all of them. */
function distinctChoices(choices: RequiredChoice[]): RequiredChoice[] {
  const seen = new Map<string, RequiredChoice>();
  for (const choice of choices) {
    const key = mergeLines(choice.lines)
      .map((line) => `${line.inventoryItemId}:${line.quantity}`)
      .sort()
      .join('|');
    if (!seen.has(key)) seen.set(key, choice);
  }
  return [...seen.values()];
}

/**
 * POS-PERF-P57 — can one unit be sold when each group needs exactly one choice?
 * Quantities add up across groups, because one sale takes them all, and are
 * never added across the alternatives inside a group. Blocked means no
 * combination fits; the combination with the fewest and smallest shortfalls is
 * returned, so the report names what would have to be restocked.
 */
export function evaluateRequiredChoices(fixedLines: StockLine[], groups: RequiredChoice[][], availableOf: (inventoryItemId: string) => number): RequiredChoiceResult {
  const distinct = groups.map(distinctChoices);
  if (distinct.reduce((total, group) => total * group.length, 1) > MAX_COMBINATIONS) return { outcome: 'too_many' };

  let best: { maxUnits: number; lines: StockLine[] } | null = null;
  let closest: { names: string[]; lines: StockLine[]; short: StockLine[]; deficit: number } | null = null;

  const visit = (index: number, picked: RequiredChoice[]): void => {
    const group = distinct[index];
    if (group) {
      for (const choice of group) visit(index + 1, [...picked, choice]);
      return;
    }
    const lines = mergeLines(fixedLines, ...picked.map((choice) => choice.lines));
    const short = lines.filter((line) => line.quantity > availableOf(line.inventoryItemId));
    if (short.length === 0) {
      const maxUnits = lines.reduce((units, line) => (line.quantity > 0 ? Math.min(units, Math.floor(availableOf(line.inventoryItemId) / line.quantity)) : units), Infinity);
      if (!best || maxUnits > best.maxUnits) best = { maxUnits, lines };
      return;
    }
    const deficit = short.reduce((total, line) => total + line.quantity - availableOf(line.inventoryItemId), 0);
    if (!closest || short.length < closest.short.length || (short.length === closest.short.length && deficit < closest.deficit)) {
      closest = { names: picked.map((choice) => choice.name), lines, short, deficit };
    }
  };
  visit(0, []);

  // Narrowing is lost across the closure assignments above.
  const found = best as { maxUnits: number; lines: StockLine[] } | null;
  if (found) return { outcome: 'sellable', maxUnits: found.maxUnits, lines: found.lines };
  const nearest = closest as { names: string[]; lines: StockLine[]; short: StockLine[] } | null;
  return nearest ? { outcome: 'blocked', names: nearest.names, lines: nearest.lines, short: nearest.short } : { outcome: 'too_many' };
}

interface StockChoiceVariant {
  id: string;
  variantFlavors: { flavorId: string; flavor: { name: string } }[];
  flavorSlots?: {
    label: string;
    snackOptions: {
      snackProductVariant: {
        id: string;
        name: string;
        isActive: boolean;
        product: { name: string; status: string; branchAvailability: { isAvailable: boolean }[] };
        variantFlavors: { flavorId: string; flavor: { name: string } }[];
      };
    }[];
  }[];
  optionGroupAssignments: {
    required: boolean | null;
    optionGroup: {
      id: string;
      name: string;
      posButtonLabel: string | null;
      selectionType: string;
      required: boolean;
      minSelections: number;
      isActive: boolean;
      options: { id: string; name: string }[];
    };
    allowedOptions: { productOption: { id: string; name: string; isActive: boolean } }[];
  }[];
}

/**
 * POS-PERF-P57 — what checkout makes a cashier pick for this variant, read by
 * the same rules: every slot needs one snack and flavor whether or not it's
 * flagged required, a slot variant ignores its own flavors, and an "Add-ons"
 * group is never required however it's flagged (resolveSelectedOptions).
 */
export function toStockChoiceRequest(variant: StockChoiceVariant, disabledFlavors: ReadonlySet<string>): CatalogStockRequest {
  const offeredFlavors = variant.variantFlavors.filter((vf) => !disabledFlavors.has(vf.flavorId));
  const slots = (variant.flavorSlots ?? []).map((slot) => ({
    label: slot.label,
    options: slot.snackOptions
      .map((option) => option.snackProductVariant)
      .filter((snack) => snack.isActive && snack.product.status === 'active' && snack.product.branchAvailability[0]?.isAvailable === true)
      .map((snack) => ({
        productVariantId: snack.id,
        name: `${snack.product.name} ${snack.name}`,
        flavors: snack.variantFlavors.filter((vf) => !disabledFlavors.has(vf.flavorId)).map((vf) => ({ flavorId: vf.flavorId, name: vf.flavor.name })),
      })),
  }));

  const offered = variant.optionGroupAssignments.flatMap((assignment) => {
    const group = assignment.optionGroup;
    if (!group.isActive) return [];
    const allowed = assignment.allowedOptions.map((row) => row.productOption).filter((option) => option.isActive);
    const options = assignment.allowedOptions.length > 0 ? allowed : group.options;
    if (options.length === 0) return [];
    return [{ group, options, configuredMinimum: Math.max(group.minSelections, (assignment.required ?? group.required) ? 1 : 0) }];
  });
  const quantityGroups = offered.filter(({ group }) => !isAddOnsOptionGroup(group) && group.selectionType === 'MULTIPLE');
  const servingCountGroup = quantityGroups.length === 1 && quantityGroups[0] && quantityGroups[0].configuredMinimum > 0 ? quantityGroups[0].group.id : null;
  const requiredPicks = offered.flatMap(({ group, options, configuredMinimum }) => {
    if (isAddOnsOptionGroup(group)) return [];
    const perServing = group.selectionType === 'SINGLE' || group.id === servingCountGroup;
    const minimum = perServing ? Math.min(configuredMinimum, 1) : configuredMinimum;
    return Array.from({ length: minimum }, () => options.map((option) => ({ id: option.id, name: option.name })));
  });

  const flavorIds = slots.length > 0 ? [] : offeredFlavors.map((vf) => vf.flavorId);
  if (slots.length === 0 && requiredPicks.length === 0) return { productVariantId: variant.id, flavorIds };
  return {
    productVariantId: variant.id,
    flavorIds,
    choices: { flavorNames: new Map(offeredFlavors.map((vf) => [vf.flavorId, vf.flavor.name])), slots, requiredPicks },
  };
}
