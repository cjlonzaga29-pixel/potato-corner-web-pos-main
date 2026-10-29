import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AddOnsDialog, groupPickLimit, isMultiGroupComplete, multiGroupTarget, servingCountGroup, type AddOnsDialogGroup, type AddOnSelections } from './add-ons-dialog';
import type { AddOnAssignments } from '@/lib/pos/split-add-ons';

afterEach(() => {
  cleanup();
});

const LONG_FLAVOR_NAME = 'Extraordinarily Long Limited-Edition Truffle Parmesan Garlic Butter Cheese Overload Flavor';

function singleFlavorGroup(overrides: Partial<AddOnsDialogGroup> = {}): AddOnsDialogGroup {
  return {
    id: 'flavor-group',
    name: 'Flavor',
    label: 'Flavor',
    allowNoAddOn: false,
    simplified: false,
    selectionType: 'SINGLE',
    required: true,
    minSelections: 1,
    maxSelections: 1,
    options: [
      { id: 'opt-sourcream', name: 'Sour Cream', price_adjustment: 0 },
      { id: 'opt-bbq', name: 'BBQ', price_adjustment: 0 },
      { id: 'opt-long', name: LONG_FLAVOR_NAME, price_adjustment: 15 },
    ],
    ...overrides,
  };
}

function premiumAddOnGroup(overrides: Partial<AddOnsDialogGroup> = {}): AddOnsDialogGroup {
  return {
    id: 'premium-group',
    name: 'Premium Flavor Upgrade',
    label: 'Premium Flavor Upgrade',
    allowNoAddOn: false,
    simplified: false,
    selectionType: 'MULTIPLE',
    required: true,
    minSelections: 2,
    maxSelections: 2,
    options: [
      { id: 'opt-cheese', name: 'Cheese Sauce', price_adjustment: 20 },
      { id: 'opt-caramel', name: 'Caramel Drizzle', price_adjustment: 25 },
    ],
    ...overrides,
  };
}

interface HarnessOverrides {
  groups?: AddOnsDialogGroup[];
  selectedOptionIds?: AddOnSelections;
  assignments?: AddOnAssignments;
  onConfirm?: () => void;
  onCancel?: () => void;
}

function renderDialog({ groups = [], selectedOptionIds = {}, assignments = {}, onConfirm = vi.fn(), onCancel = vi.fn() }: HarnessOverrides = {}) {
  const onAdjustAssignment = vi.fn();
  const onToggleOption = vi.fn();
  const onSelectOption = vi.fn();
  const onClearGroup = vi.fn();

  const utils = render(
    <AddOnsDialog
      productName="Overload Bites"
      variantName="Large"
      groups={groups}
      quantity={1}
      assignments={assignments}
      onAdjustAssignment={onAdjustAssignment}
      selectedOptionIds={selectedOptionIds}
      onToggleOption={onToggleOption}
      onSelectOption={onSelectOption}
      onClearGroup={onClearGroup}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );

  return { ...utils, onAdjustAssignment, onToggleOption, onSelectOption, onClearGroup, onConfirm, onCancel };
}

describe('AddOnsDialog — header and instructions', () => {
  it('shows the product name, variant, and a per-group selection requirement', () => {
    renderDialog({ groups: [singleFlavorGroup(), premiumAddOnGroup()] });
    expect(screen.getByText('Overload Bites')).toBeInTheDocument();
    expect(screen.getByText('Large')).toBeInTheDocument();
    // Required SINGLE group shows a Required/Selected badge tied to the group.
    expect(screen.getByText('Required')).toBeInTheDocument();
    // Required MULTIPLE group shows its target count tied to the group.
    expect(screen.getByText('Choose 2')).toBeInTheDocument();
  });
});

describe('AddOnsDialog — long option names', () => {
  it('renders a long flavor name without any fixed-width/no-wrap class that would force horizontal overflow', () => {
    renderDialog({ groups: [singleFlavorGroup()] });
    const longLabel = screen.getByText((text) => text.startsWith('Extraordinarily Long'));
    // Task 209.56C — the wrapping text column must be min-w-0 + flex-1 +
    // break-words; a flex child without min-w-0 defaults to its max-content
    // width, which is exactly what pushes the row (and the dialog) into a
    // horizontal scrollbar instead of wrapping.
    expect(longLabel.className).toContain('min-w-0');
    expect(longLabel.className).toContain('flex-1');
    expect(longLabel.className).toContain('break-words');
    expect(longLabel.className).not.toMatch(/\btruncate\b|\bwhitespace-nowrap\b/);
  });

  it('gives the Remove-one control a stable, shrink-proof width next to a long premium option name', () => {
    const longPremiumGroup = premiumAddOnGroup({
      options: [{ id: 'opt-long-premium', name: LONG_FLAVOR_NAME, price_adjustment: 30 }],
      minSelections: 1,
      maxSelections: 1,
    });
    renderDialog({ groups: [longPremiumGroup], assignments: { 'premium-group': { 'opt-long-premium': 1 } } });
    const removeButton = screen.getByRole('button', { name: `Remove one ${LONG_FLAVOR_NAME}` });
    expect(removeButton.className).toContain('shrink-0');
    expect(screen.getByText(LONG_FLAVOR_NAME).className).toContain('break-words');
  });
});

describe('AddOnsDialog — regular (SINGLE-selection) flavors', () => {
  it('renders every flavor as its own row and toggling one calls onSelectOption (radio behavior)', () => {
    const { onSelectOption } = renderDialog({ groups: [singleFlavorGroup()] });
    expect(screen.getByText('Sour Cream')).toBeInTheDocument();
    expect(screen.getByText('BBQ')).toBeInTheDocument();
    fireEvent.click(screen.getByText('BBQ'));
    expect(onSelectOption).toHaveBeenCalledWith('flavor-group', 'opt-bbq');
  });

  it('disables Add until a required SINGLE group has a selection', () => {
    const { rerender } = renderDialog({ groups: [singleFlavorGroup()], selectedOptionIds: {} });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    cleanup();
    renderDialog({ groups: [singleFlavorGroup()], selectedOptionIds: { 'flavor-group': ['opt-bbq'] } });
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
    void rerender;
  });
});

describe('AddOnsDialog — premium (MULTIPLE-selection) add-ons', () => {
  it('tapping anywhere on a quantity card adds exactly one', () => {
    const { onAdjustAssignment } = renderDialog({ groups: [premiumAddOnGroup()] });
    // The name and price live inside the card's one button, so a tap on either reaches the same single handler.
    fireEvent.click(screen.getByText('Cheese Sauce'));
    fireEvent.click(screen.getByText('+₱20.00'));
    expect(onAdjustAssignment).toHaveBeenCalledTimes(2);
    expect(onAdjustAssignment).toHaveBeenNthCalledWith(1, 'premium-group', 'opt-cheese', 1);
    expect(onAdjustAssignment).toHaveBeenNthCalledWith(2, 'premium-group', 'opt-cheese', 1);
  });

  it('shows the picked quantity as a badge and offers Remove one only once something is picked', () => {
    const { onAdjustAssignment } = renderDialog({ groups: [premiumAddOnGroup()], assignments: { 'premium-group': { 'opt-cheese': 2 } } });
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove one Caramel Drizzle' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove one Cheese Sauce' }));
    expect(onAdjustAssignment).toHaveBeenCalledTimes(1);
    expect(onAdjustAssignment).toHaveBeenCalledWith('premium-group', 'opt-cheese', -1);
  });

  it('a card at the group limit stays focusable but adds nothing', () => {
    const { onAdjustAssignment } = renderDialog({ groups: [premiumAddOnGroup()], assignments: { 'premium-group': { 'opt-cheese': 2 } } });
    const caramel = screen.getByRole('button', { name: 'Add one Caramel Drizzle' });
    expect(caramel).toHaveAttribute('aria-disabled', 'true');
    expect(caramel).not.toBeDisabled();
    fireEvent.click(caramel);
    expect(onAdjustAssignment).not.toHaveBeenCalled();
  });

  it('shows the "Assigned N / M" progress text tied to the group and gates Add on it', () => {
    renderDialog({ groups: [premiumAddOnGroup()], assignments: { 'premium-group': { 'opt-cheese': 1 } } });
    expect(screen.getByText('Assigned 1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('enables Add once the MULTIPLE group reaches its own required target', () => {
    const group = premiumAddOnGroup();
    renderDialog({ groups: [group], assignments: { 'premium-group': { 'opt-cheese': 2 } } });
    expect(multiGroupTarget(group)).toBe(2);
    expect(screen.getByText('Assigned 2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
  });
});

describe('AddOnsDialog — structure (mobile/desktop-agnostic, single shared markup)', () => {
  it('scrolls only the choices: title, Close, Cancel and Add sit outside the scroll region', () => {
    renderDialog({ groups: [singleFlavorGroup(), premiumAddOnGroup()] });
    const region = screen.getByTestId('add-ons-scroll-region');
    expect(region.className).toContain('overflow-y-auto');
    expect(region.className).toContain('min-h-0');
    expect(region).toContainElement(screen.getByText('BBQ'));
    for (const name of ['Add', 'Cancel', 'Close']) {
      expect(region).not.toContainElement(screen.getByRole('button', { name }));
    }
    expect(region).not.toContainElement(screen.getByText('Overload Bites'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('flex-col');
    expect(dialog.className).toContain('overflow-hidden');
  });

  it('renders Cancel and calls onCancel', () => {
    const { onCancel } = renderDialog({ groups: [singleFlavorGroup()] });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('labels the confirm button "Save" in edit mode instead of "Add"', () => {
    const onConfirm = vi.fn();
    render(
      <AddOnsDialog
        productName="Overload Bites"
        variantName="Large"
        groups={[singleFlavorGroup()]}
        quantity={2}
        assignments={{}}
        onAdjustAssignment={vi.fn()}
        selectedOptionIds={{ 'flavor-group': ['opt-bbq'] }}
        onToggleOption={vi.fn()}
        onSelectOption={vi.fn()}
        onClearGroup={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        isEditMode
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});

function addOnsChecklistGroup(overrides: Partial<AddOnsDialogGroup> = {}): AddOnsDialogGroup {
  return {
    id: 'addons-group',
    name: 'Add-ons',
    label: 'Add-ons',
    allowNoAddOn: true,
    simplified: true,
    selectionType: 'MULTIPLE',
    required: false,
    minSelections: 0,
    maxSelections: null,
    options: [
      { id: 'opt-cheese-dip', name: 'Cheese Dip', price_adjustment: 15 },
      { id: 'opt-ketchup', name: 'Ketchup', price_adjustment: 0 },
    ],
    ...overrides,
  };
}

describe('AddOnsDialog — P46 whole-card choices and optional groups', () => {
  it('renders every choice as one pressed/unpressed card button carrying its name and price', () => {
    renderDialog({ groups: [singleFlavorGroup()], selectedOptionIds: { 'flavor-group': ['opt-bbq'] } });
    expect(screen.getByRole('button', { name: /^BBQ/, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sour Cream/, pressed: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Truffle.*\+₱15\.00$/ })).toBeInTheDocument();
  });

  it('a required single choice is not un-picked by tapping it again', () => {
    const { onSelectOption, onClearGroup } = renderDialog({ groups: [singleFlavorGroup()], selectedOptionIds: { 'flavor-group': ['opt-bbq'] } });
    fireEvent.click(screen.getByText('BBQ'));
    expect(onSelectOption).not.toHaveBeenCalled();
    expect(onClearGroup).not.toHaveBeenCalled();
  });

  it('an optional single choice un-picks on a second tap', () => {
    const { onClearGroup } = renderDialog({
      groups: [singleFlavorGroup({ required: false, minSelections: 0, allowNoAddOn: true })],
      selectedOptionIds: { 'flavor-group': ['opt-bbq'] },
    });
    fireEvent.click(screen.getByText('BBQ'));
    expect(onClearGroup).toHaveBeenCalledWith('flavor-group');
  });

  it('an optional Add-ons checklist left empty allows Add and never shows a No Add-ons choice', () => {
    renderDialog({ groups: [addOnsChecklistGroup()] });
    expect(screen.queryByText('No Add-ons')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
  });

  it('tapping an Add-ons card toggles it, and Clear empties the group', () => {
    const { onToggleOption, onClearGroup } = renderDialog({ groups: [addOnsChecklistGroup()], selectedOptionIds: { 'addons-group': ['opt-ketchup'] } });
    fireEvent.click(screen.getByText('Cheese Dip'));
    expect(onToggleOption).toHaveBeenCalledWith('addons-group', 'opt-cheese-dip');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Add-ons' }));
    expect(onClearGroup).toHaveBeenCalledWith('addons-group');
  });

  it('an optional MULTIPLE group is valid empty or partly filled, never over its limit', () => {
    const optional = premiumAddOnGroup({ allowNoAddOn: true, required: false, minSelections: 0, maxSelections: 2 });
    renderDialog({ groups: [optional] });
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText('No Add-ons')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
    expect(isMultiGroupComplete(optional, { 'opt-cheese': 1 })).toBe(true);
    expect(isMultiGroupComplete(optional, { 'opt-cheese': 3 })).toBe(false);
  });

  it('a required MULTIPLE group still needs its exact count, and the footer names what is missing', () => {
    renderDialog({ groups: [singleFlavorGroup(), premiumAddOnGroup()], assignments: { 'premium-group': { 'opt-cheese': 1 } } });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByText('Still needed: Flavor, Premium Flavor Upgrade')).toBeInTheDocument();
  });

  it('a legacy No-Add-on sentinel never counts as a pick', () => {
    const optional = premiumAddOnGroup({ allowNoAddOn: true, required: false, minSelections: 0, maxSelections: 2 });
    renderDialog({ groups: [optional], assignments: { 'premium-group': { __none__: 2 } } });
    expect(screen.getByText('Assigned 0 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add one Cheese Sauce' })).not.toHaveAttribute('aria-disabled');
  });

  it('P46R — only a lone required MULTIPLE group is a serving count; optional ones are extras on one product', () => {
    const required = premiumAddOnGroup();
    const optional = premiumAddOnGroup({ id: 'extras', allowNoAddOn: true, required: false, minSelections: 0, maxSelections: 2 });
    expect(servingCountGroup([required])).toBe(required);
    expect(servingCountGroup([optional])).toBeUndefined();
    expect(servingCountGroup([required, optional])).toBeUndefined();
    expect(servingCountGroup([singleFlavorGroup()])).toBeUndefined();
  });

  it('P46R — pick limits: max_selections for optional and Add-ons groups (null = unlimited), the exact target when required', () => {
    expect(groupPickLimit(premiumAddOnGroup())).toBe(2);
    expect(groupPickLimit(premiumAddOnGroup({ allowNoAddOn: true, required: false, minSelections: 0, maxSelections: null }))).toBeNull();
    expect(groupPickLimit(premiumAddOnGroup({ simplified: true, maxSelections: 3 }))).toBe(3);
    expect(groupPickLimit(singleFlavorGroup())).toBe(1);
    const unlimited = premiumAddOnGroup({ allowNoAddOn: true, required: false, minSelections: 0, maxSelections: null });
    expect(isMultiGroupComplete(unlimited, { 'opt-cheese': 9 })).toBe(true);
  });

  it('P46R — no "Adds N items" note for optional extras; the note stays for a required serving count', () => {
    renderDialog({ groups: [premiumAddOnGroup({ allowNoAddOn: true, required: false, minSelections: 0, maxSelections: 2 })] });
    expect(screen.queryByText(/Adds \d+ items/)).not.toBeInTheDocument();
    cleanup();
    renderDialog({ groups: [premiumAddOnGroup()] });
    expect(screen.getByText('Adds 2 items — one per Premium Flavor Upgrade pick.')).toBeInTheDocument();
  });

  it('P46R — an edited Add-ons selection above the group maximum blocks Save until trimmed', () => {
    const addOns = { ...premiumAddOnGroup({ id: 'addons', label: 'Add-ons', name: 'Add-ons', simplified: true, allowNoAddOn: true, required: false, minSelections: 0, maxSelections: 1 }) };
    renderDialog({ groups: [addOns], selectedOptionIds: { addons: ['opt-cheese', 'opt-caramel'] } });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByText('Still needed: Add-ons')).toBeInTheDocument();
  });
});
