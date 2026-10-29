import { describe, it, expect } from 'vitest';
import { splitAddOnLines, assignedQuantity, chosenQuantity, fillWithNoAddOn, NO_ADD_ON_KEY, type AddOnSplitGroup } from './split-add-ons';

const friesGroup: AddOnSplitGroup = {
  id: 'group-1',
  name: 'Flavor',
  options: [
    { id: 'cheese', name: 'Cheese', price_adjustment: 0 },
    { id: 'bbq', name: 'BBQ', price_adjustment: 0 },
    { id: 'sour-cream', name: 'Sour Cream', price_adjustment: 0 },
  ],
};

describe('splitAddOnLines', () => {
  it('Qty 3, Cheese x3 -> one cart line of Qty 3', () => {
    const lines = splitAddOnLines([friesGroup], { [friesGroup.id]: { cheese: 3 } }, 3);
    expect(lines).toEqual([
      {
        quantity: 3,
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Flavor', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 0 },
        ],
      },
    ]);
  });

  it('Qty 3, Cheese x2 + No Add-ons x1 -> two cart lines', () => {
    const lines = splitAddOnLines([friesGroup], { [friesGroup.id]: { cheese: 2, [NO_ADD_ON_KEY]: 1 } }, 3);
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual({
      quantity: 2,
      selected_options: [
        { option_group_id: 'group-1', option_group_name: 'Flavor', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 0 },
      ],
    });
    expect(lines).toContainEqual({ quantity: 1, selected_options: [] });
  });

  it('Qty 5, BBQ x2 + Cheese x2 + No Add-ons x1 -> three cart lines', () => {
    const lines = splitAddOnLines([friesGroup], { [friesGroup.id]: { bbq: 2, cheese: 2, [NO_ADD_ON_KEY]: 1 } }, 5);
    expect(lines).toHaveLength(3);
    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    expect(totalQty).toBe(5);
  });

  it('does not create one line with per-option applied_quantity — every returned line has exactly one selected_options set', () => {
    const lines = splitAddOnLines([friesGroup], { [friesGroup.id]: { bbq: 1, cheese: 2 } }, 3);
    for (const line of lines) {
      expect(line.selected_options.length).toBeLessThanOrEqual(1);
    }
  });

  it('bails out (empty array) when a group is not fully assigned', () => {
    const lines = splitAddOnLines([friesGroup], { [friesGroup.id]: { cheese: 1 } }, 3);
    expect(lines).toEqual([]);
  });

  it('combines two groups per unit, collapsing identical combinations into one line', () => {
    const sauceGroup: AddOnSplitGroup = {
      id: 'group-2',
      name: 'Sauce',
      options: [{ id: 'ketchup', name: 'Ketchup', price_adjustment: 5 }],
    };
    const lines = splitAddOnLines(
      [friesGroup, sauceGroup],
      { [friesGroup.id]: { cheese: 3 }, [sauceGroup.id]: { ketchup: 3 } },
      3,
    );
    expect(lines).toEqual([
      {
        quantity: 3,
        selected_options: [
          { option_group_id: 'group-1', option_group_name: 'Flavor', option_id: 'cheese', option_name: 'Cheese', price_adjustment: 0 },
          { option_group_id: 'group-2', option_group_name: 'Sauce', option_id: 'ketchup', option_name: 'Ketchup', price_adjustment: 5 },
        ],
      },
    ]);
  });

  it('returns an empty array for zero groups', () => {
    expect(splitAddOnLines([], {}, 3)).toEqual([]);
  });
});

describe('assignedQuantity', () => {
  it('sums all quantities in a group assignment', () => {
    expect(assignedQuantity({ cheese: 2, bbq: 1 })).toBe(3);
  });

  it('returns 0 for an undefined assignment', () => {
    expect(assignedQuantity(undefined)).toBe(0);
  });
});

describe('chosenQuantity / fillWithNoAddOn (P46)', () => {
  it('counts real picks only, never the No Add-on sentinel', () => {
    expect(chosenQuantity({ a: 1, b: 2, [NO_ADD_ON_KEY]: 3 })).toBe(3);
    expect(chosenQuantity(undefined)).toBe(0);
  });

  it('fills an empty optional group entirely with no-add-on units', () => {
    expect(fillWithNoAddOn(undefined, 2)).toEqual({ [NO_ADD_ON_KEY]: 2 });
  });

  it('fills only the unpicked remainder and drops a stale sentinel or zero counts', () => {
    expect(fillWithNoAddOn({ a: 1, b: 0, [NO_ADD_ON_KEY]: 5 }, 3)).toEqual({ a: 1, [NO_ADD_ON_KEY]: 2 });
  });

  it('adds no sentinel once the picks already reach the target', () => {
    expect(fillWithNoAddOn({ a: 2 }, 2)).toEqual({ a: 2 });
  });

  it('a partly filled optional group splits into the same lines the old manual No Add-ons flow produced', () => {
    const filled = fillWithNoAddOn({ cheese: 1 }, 3);
    expect(splitAddOnLines([friesGroup], { [friesGroup.id]: filled }, 3)).toEqual(
      splitAddOnLines([friesGroup], { [friesGroup.id]: { cheese: 1, [NO_ADD_ON_KEY]: 2 } }, 3),
    );
  });
});
