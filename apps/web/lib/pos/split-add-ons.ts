import type { PosCartSelectedOption } from '@/stores/cart.store';

/** Sentinel key for "No Add-ons" within a group's assignment map. */
export const NO_ADD_ON_KEY = '__none__';

/**
 * Task 131 — matches a Product Option Group configured as the POS "Add-ons"
 * group, which gets the simplified optional-multi-select flow instead of the
 * legacy per-choice quantity allocator. Matches on pos_button_label (the
 * cashier-facing override) first, falling back to the internal name — never
 * matches unrelated groups like Size/Flavor just because they're assigned.
 */
export function isAddOnsGroup(group: { name: string; pos_button_label?: string | null }): boolean {
  const label = group.pos_button_label?.trim().toLowerCase() ?? '';
  if (label) return label.includes('add-on');
  return group.name.toLowerCase().includes('add-on');
}

export interface AddOnSplitGroup {
  id: string;
  name: string;
  options: { id: string; name: string; price_adjustment: number }[];
}

/** groupId -> (optionId | NO_ADD_ON_KEY) -> quantity assigned to that choice */
export type AddOnAssignments = Record<string, Record<string, number>>;

export interface AddOnSplitLine {
  quantity: number;
  selected_options: PosCartSelectedOption[];
}

/** Sum of all quantities assigned within one group. */
export function assignedQuantity(assignment: Record<string, number> | undefined): number {
  if (!assignment) return 0;
  return Object.values(assignment).reduce((sum, qty) => sum + qty, 0);
}

/**
 * Task 107 — per-unit add-on assignment, not per-line applied_quantity.
 * Every group's assigned quantities must sum to exactly `quantity`
 * (validated by the caller before invoking this). Expands each group's
 * assignment into one choice per unit, zips across groups by unit index,
 * then collapses units sharing an identical combination of choices into a
 * single cart line — never a single line carrying per-option quantities.
 */
export function splitAddOnLines(groups: AddOnSplitGroup[], assignments: AddOnAssignments, quantity: number): AddOnSplitLine[] {
  if (quantity <= 0 || groups.length === 0) return [];

  const perGroupExpansion = groups.map((group) => {
    const groupAssignment = assignments[group.id] ?? {};
    const expansion: string[] = [];
    for (let i = 0; i < (groupAssignment[NO_ADD_ON_KEY] ?? 0); i++) expansion.push(NO_ADD_ON_KEY);
    for (const option of group.options) {
      for (let i = 0; i < (groupAssignment[option.id] ?? 0); i++) expansion.push(option.id);
    }
    return expansion;
  });

  if (perGroupExpansion.some((expansion) => expansion.length !== quantity)) return [];

  const lines: { key: string; quantity: number; selected_options: PosCartSelectedOption[] }[] = [];
  const indexByKey = new Map<string, number>();

  for (let unit = 0; unit < quantity; unit++) {
    const selectedOptions: PosCartSelectedOption[] = [];
    groups.forEach((group, groupIndex) => {
      const optionId = perGroupExpansion[groupIndex]?.[unit];
      if (!optionId || optionId === NO_ADD_ON_KEY) return;
      const option = group.options.find((o) => o.id === optionId);
      if (!option) return;
      selectedOptions.push({
        option_group_id: group.id,
        option_group_name: group.name,
        option_id: option.id,
        option_name: option.name,
        price_adjustment: option.price_adjustment,
      });
    });

    const key = selectedOptions
      .map((o) => o.option_id)
      .sort()
      .join('|');
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, lines.length);
      lines.push({ key, quantity: 1, selected_options: selectedOptions });
    } else {
      const line = lines[existingIndex];
      if (line) line.quantity += 1;
    }
  }

  return lines.map(({ quantity: lineQuantity, selected_options }) => ({ quantity: lineQuantity, selected_options }));
}
