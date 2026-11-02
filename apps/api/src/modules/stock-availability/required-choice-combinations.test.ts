import { describe, it, expect } from 'vitest';
import { evaluateRequiredChoices, toStockChoiceRequest } from './required-choice-combinations.js';

const stock = (levels: Record<string, number>) => (itemId: string) => levels[itemId] ?? 0;
const choice = (name: string, ...lines: [string, number][]) => ({ name, lines: lines.map(([inventoryItemId, quantity]) => ({ inventoryItemId, quantity })) });

describe('evaluateRequiredChoices', () => {
  it('adds quantities across groups, never across the alternatives inside one', () => {
    const fries = choice('Fries', ['fries', 40]);
    const pops = choice('Pops', ['pops', 40]);
    expect(evaluateRequiredChoices([], [[fries, pops]], stock({ fries: 40, pops: 0 })).outcome).toBe('sellable');
    expect(evaluateRequiredChoices([], [[fries], [fries]], stock({ fries: 60 }))).toMatchObject({ outcome: 'blocked', short: [{ inventoryItemId: 'fries', quantity: 80 }] });
    expect(evaluateRequiredChoices([], [[fries, pops], [fries, pops]], stock({ fries: 60, pops: 40 })).outcome).toBe('sellable');
  });

  it('includes fixed lines, and reports how many whole units the best combination covers', () => {
    const fries = choice('Fries', ['fries', 40]);
    const pops = choice('Pops', ['pops', 10]);
    const result = evaluateRequiredChoices([{ inventoryItemId: 'box', quantity: 1 }], [[fries, pops]], stock({ box: 3, fries: 80, pops: 100 }));
    expect(result).toMatchObject({ outcome: 'sellable', maxUnits: 3 });
    expect(evaluateRequiredChoices([{ inventoryItemId: 'fries', quantity: 10 }], [[fries]], stock({ fries: 45 }))).toMatchObject({ outcome: 'blocked', short: [{ quantity: 50 }] });
  });

  it('names the closest combination when none fits: fewest short items, then the smallest gap', () => {
    const big = choice('Big', ['a', 100], ['b', 100]);
    const near = choice('Near', ['a', 15]);
    const far = choice('Far', ['a', 90]);
    expect(evaluateRequiredChoices([], [[big, far, near]], stock({ a: 10, b: 10 }))).toMatchObject({ outcome: 'blocked', names: ['Near'], short: [{ inventoryItemId: 'a', quantity: 15 }] });
  });

  it('treats choices using the same stock as one, so identical flavors do not multiply the search', () => {
    const many = Array.from({ length: 100 }, (_, index) => choice(`Flavor ${index}`, ['fries', 1]));
    expect(evaluateRequiredChoices([], [many, many, many], stock({ fries: 3 })).outcome).toBe('sellable');
  });

  it('claims nothing when the search is too large, so a size is never called short on a partial look', () => {
    const many = Array.from({ length: 100 }, (_, index) => choice(`Snack ${index}`, [`item-${index}`, 1]));
    expect(evaluateRequiredChoices([], [many, many], stock({}))).toEqual({ outcome: 'too_many' });
  });

  it('a choice with no stock lines always fits', () => {
    expect(evaluateRequiredChoices([], [[choice('Free')]], stock({})).outcome).toBe('sellable');
  });
});

describe('toStockChoiceRequest', () => {
  const group = (overrides: Record<string, unknown>) => ({
    required: null,
    allowedOptions: [],
    optionGroup: { id: 'g', name: 'Sauce', posButtonLabel: null, selectionType: 'SINGLE', required: true, minSelections: 1, isActive: true, options: [{ id: 'o', name: 'Mayo' }], ...overrides },
  });
  const snack = (overrides: Record<string, unknown> = {}) => ({
    snackProductVariant: { id: 's', name: 'Regular', isActive: true, product: { name: 'Fries', status: 'active', branchAvailability: [{ isAvailable: true }] }, variantFlavors: [{ flavorId: 'f', flavor: { name: 'Cheese' } }], ...overrides },
  });
  const base = { id: 'v', variantFlavors: [{ flavorId: 'pf', flavor: { name: 'Parent' } }], optionGroupAssignments: [] };

  it('leaves a plain flavored variant to the flavor check', () => {
    expect(toStockChoiceRequest(base, new Set())).toEqual({ productVariantId: 'v', flavorIds: ['pf'] });
  });

  it('a slot variant ignores its own flavors, as checkout does, and keeps only what the POS offers', () => {
    const request = toStockChoiceRequest(
      { ...base, flavorSlots: [{ label: 'A', snackOptions: [snack(), snack({ id: 'off', isActive: false }), snack({ id: 'gone', product: { name: 'X', status: 'active', branchAvailability: [{ isAvailable: false }] } })] }] },
      new Set(),
    );
    expect(request.flavorIds).toEqual([]);
    expect(request.choices?.slots[0]?.options.map((option) => option.productVariantId)).toEqual(['s']);
  });

  it('drops a flavor disabled at the branch from a snack, leaving the slot to report setup', () => {
    const request = toStockChoiceRequest({ ...base, flavorSlots: [{ label: 'A', snackOptions: [snack()] }] }, new Set(['f']));
    expect(request.choices?.slots[0]?.options[0]?.flavors).toEqual([]);
  });

  it('follows checkout on which option groups must be picked', () => {
    const picks = (assignment: ReturnType<typeof group>) => toStockChoiceRequest({ ...base, optionGroupAssignments: [assignment] }, new Set()).choices?.requiredPicks.length ?? 0;
    expect(picks(group({}))).toBe(1);
    expect(picks(group({ required: false, minSelections: 0 }))).toBe(0);
    expect(picks(group({ name: 'Add-ons' }))).toBe(0);
    expect(picks(group({ isActive: false }))).toBe(0);
    expect(picks(group({ selectionType: 'SINGLE', minSelections: 3 }))).toBe(1);
    // The only MULTIPLE group counts servings, one pick per unit; alongside another it needs its full minimum.
    expect(picks(group({ selectionType: 'MULTIPLE', minSelections: 2 }))).toBe(1);
    const two = toStockChoiceRequest({ ...base, optionGroupAssignments: [group({ selectionType: 'MULTIPLE', minSelections: 2 }), group({ id: 'g2', selectionType: 'MULTIPLE', minSelections: 0, required: false })] }, new Set());
    expect(two.choices?.requiredPicks).toHaveLength(2);
  });
});
