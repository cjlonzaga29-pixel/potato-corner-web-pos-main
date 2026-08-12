import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AddOnsDialog, multiGroupTarget, type AddOnsDialogGroup, type AddOnSelections } from './add-ons-dialog';
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
    allowNoAddOn: true,
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
  const onAssignmentChange = vi.fn();
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
      onAssignmentChange={onAssignmentChange}
      selectedOptionIds={selectedOptionIds}
      onToggleOption={onToggleOption}
      onSelectOption={onSelectOption}
      onClearGroup={onClearGroup}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );

  return { ...utils, onAssignmentChange, onToggleOption, onSelectOption, onClearGroup, onConfirm, onCancel };
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

  it('gives the counter/button column a stable, shrink-proof width next to a long premium option name', () => {
    const longPremiumGroup = premiumAddOnGroup({
      options: [{ id: 'opt-long-premium', name: LONG_FLAVOR_NAME, price_adjustment: 30 }],
      minSelections: 1,
      maxSelections: 1,
    });
    renderDialog({ groups: [longPremiumGroup] });
    const decreaseButton = screen.getByRole('button', { name: `Decrease ${LONG_FLAVOR_NAME} quantity` });
    const controlColumn = decreaseButton.parentElement;
    expect(controlColumn?.className).toContain('shrink-0');
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
  it('renders plus/minus controls per option with accessible names and calls onAssignmentChange', () => {
    const { onAssignmentChange } = renderDialog({ groups: [premiumAddOnGroup()] });
    const increase = screen.getByRole('button', { name: 'Increase Cheese Sauce quantity' });
    fireEvent.click(increase);
    expect(onAssignmentChange).toHaveBeenCalledWith('premium-group', 'opt-cheese', 1);
  });

  it('never calls onAssignmentChange with a negative quantity from Decrease at zero', () => {
    const { onAssignmentChange } = renderDialog({ groups: [premiumAddOnGroup()] });
    const decrease = screen.getByRole('button', { name: 'Decrease Cheese Sauce quantity' });
    fireEvent.click(decrease);
    expect(onAssignmentChange).not.toHaveBeenCalled();
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
  it('keeps the footer (Cancel/Add) sticky and visually separate from the scrolling option list', () => {
    renderDialog({ groups: [singleFlavorGroup(), premiumAddOnGroup()] });
    const addButton = screen.getByRole('button', { name: 'Add' });
    const footer = addButton.closest('div');
    expect(footer?.className).toContain('sticky');
    expect(footer?.className).toContain('bottom-0');
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
        onAssignmentChange={vi.fn()}
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
