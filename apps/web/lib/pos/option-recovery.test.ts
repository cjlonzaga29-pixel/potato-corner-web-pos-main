import { describe, expect, it } from 'vitest';
import type { AddOnsDialogGroup } from '@/components/pos/add-ons-dialog';
import type { PosCartItem, PosCartSelectedOption } from '@/stores/cart.store';
import { isOptionConfigErrorCode, refreshCartLineOptionDetails, reviewCartLineOptions } from './option-recovery';

function group(overrides: Partial<AddOnsDialogGroup> = {}): AddOnsDialogGroup {
  return {
    id: 'g-size',
    name: 'Size',
    label: 'Size',
    allowNoAddOn: false,
    simplified: false,
    selectionType: 'SINGLE',
    required: true,
    minSelections: 1,
    maxSelections: 1,
    options: [
      { id: 'small', name: 'Small', price_adjustment: 0 },
      { id: 'large', name: 'Large', price_adjustment: 20 },
    ],
    ...overrides,
  };
}

function picked(groupId: string, id: string, name = id, price = 0): PosCartSelectedOption {
  return { option_group_id: groupId, option_group_name: groupId, option_id: id, option_name: name, price_adjustment: price };
}

function line(selected: PosCartSelectedOption[], quantity = 1): PosCartItem {
  return { product_id: 'p', product_variant_id: 'v', quantity, ...(selected.length ? { selected_options: selected } : {}) };
}

const DIPS = group({
  id: 'g-dips',
  label: 'Dips',
  selectionType: 'MULTIPLE',
  required: false,
  minSelections: 0,
  maxSelections: 2,
  allowNoAddOn: true,
  options: [
    { id: 'garlic', name: 'Garlic', price_adjustment: 15 },
    { id: 'cheese', name: 'Cheese', price_adjustment: 15 },
  ],
});

describe('isOptionConfigErrorCode', () => {
  it('matches only the option-configuration refusals', () => {
    expect(isOptionConfigErrorCode('PRODUCT_OPTION_REQUIRED')).toBe(true);
    expect(isOptionConfigErrorCode('PRODUCT_OPTION_LIMIT_EXCEEDED')).toBe(true);
    expect(isOptionConfigErrorCode('PRODUCT_OPTION_NOT_AVAILABLE')).toBe(true);
    expect(isOptionConfigErrorCode('INSUFFICIENT_STOCK')).toBe(false);
    expect(isOptionConfigErrorCode(null)).toBe(false);
  });
});

describe('reviewCartLineOptions', () => {
  it('accepts a line that meets every group', () => {
    expect(reviewCartLineOptions(line([picked('g-size', 'large')]), [group(), DIPS])).toEqual([]);
  });

  it('reports a required SINGLE group left empty', () => {
    expect(reviewCartLineOptions(line([]), [group()])).toEqual(['Choose Size']);
  });

  it('treats a SINGLE group with min 1 but not flagged required as required (allowNoAddOn false)', () => {
    expect(reviewCartLineOptions(line([]), [group({ required: false })])).toEqual(['Choose Size']);
  });

  it('names an option that is no longer offered and still reports the requirement it no longer meets', () => {
    const groups = [group({ options: [{ id: 'small', name: 'Small', price_adjustment: 0 }] })];
    expect(reviewCartLineOptions(line([picked('g-size', 'large', 'Large')]), groups)).toEqual(['Large is no longer offered', 'Choose Size']);
  });

  it('names an option of a group that was deactivated (absent from the fresh groups)', () => {
    expect(reviewCartLineOptions(line([picked('g-size', 'large'), picked('g-gone', 'x', 'Old Dip')]), [group()])).toEqual(['Old Dip is no longer offered']);
  });

  it('never requires an Add-ons-named group, even when flagged required (Task 131)', () => {
    const addOns = group({ id: 'g-add', label: 'Add-ons', simplified: true, selectionType: 'MULTIPLE', maxSelections: null });
    expect(reviewCartLineOptions(line([]), [addOns])).toEqual([]);
  });

  it('needs one pick per line for the lone required MULTIPLE group (serving count, split per unit)', () => {
    const toppings = group({ id: 'g-top', label: 'Toppings', selectionType: 'MULTIPLE', minSelections: 2, maxSelections: 2 });
    expect(reviewCartLineOptions(line([picked('g-top', 'small')]), [toppings])).toEqual([]);
    expect(reviewCartLineOptions(line([]), [toppings])).toEqual(['Choose Toppings']);
  });

  it('needs the configured minimum for a folded required MULTIPLE group', () => {
    const sauces = group({ id: 'g-sauce', label: 'Sauces', selectionType: 'MULTIPLE', minSelections: 2, maxSelections: 3, options: [{ id: 'bbq', name: 'BBQ', price_adjustment: 0 }] });
    const toppings = group({ id: 'g-top', label: 'Toppings', selectionType: 'MULTIPLE', minSelections: 1, maxSelections: 1, options: [{ id: 'bacon', name: 'Bacon', price_adjustment: 0 }] });
    expect(reviewCartLineOptions(line([picked('g-sauce', 'bbq'), picked('g-top', 'bacon')]), [sauces, toppings])).toEqual(['Choose 2 Sauces']);
    expect(reviewCartLineOptions(line([picked('g-sauce', 'bbq'), picked('g-sauce', 'bbq'), picked('g-top', 'bacon')]), [sauces, toppings])).toEqual([]);
  });

  it('reports picks over a maximum', () => {
    expect(reviewCartLineOptions(line([picked('g-dips', 'garlic'), picked('g-dips', 'garlic'), picked('g-dips', 'cheese')]), [DIPS])).toEqual([
      'Too many Dips (up to 2)',
    ]);
  });

  it('reports a variant that is no longer sellable', () => {
    expect(reviewCartLineOptions(line([]), null)).toEqual(['No longer available at this branch']);
  });
});

describe('refreshCartLineOptionDetails', () => {
  it('takes the current name and price of each still-offered choice, keeping quantity and choices', () => {
    const item = line([picked('g-size', 'large', 'Large', 10), picked('g-dips', 'garlic', 'Garlic', 15)], 3);
    const refreshed = refreshCartLineOptionDetails(item, [group(), DIPS]);
    expect(refreshed).toEqual({ ...item, selected_options: [picked('g-size', 'large', 'Large', 20), picked('g-dips', 'garlic', 'Garlic', 15)] });
  });

  it('leaves a retired choice untouched so it stays reported, and returns the same object when nothing changed', () => {
    const item = line([picked('g-size', 'small', 'Small', 0), picked('g-gone', 'x', 'Old', 5)]);
    expect(refreshCartLineOptionDetails(item, [group()])).toBe(item);
  });
});
