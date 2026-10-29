/**
 * Task 131 — matches a Product Option Group configured as the POS "Add-ons"
 * group, which the POS treats as an optional checklist (zero or more picks,
 * capped by max_selections) regardless of its required/min_selections
 * settings. Matches on pos_button_label (the cashier-facing override) first,
 * falling back to the internal name — never matches unrelated groups like
 * Size/Flavor just because they're assigned.
 *
 * P46R2 — shared so checkout (transactions.service.ts) classifies a group
 * exactly as the POS dialog does; the two must never disagree about which
 * groups may be left empty.
 */
export function isAddOnsOptionGroup(group: { name: string; posButtonLabel?: string | null }): boolean {
  const label = group.posButtonLabel?.trim().toLowerCase() ?? '';
  if (label) return label.includes('add-on');
  return group.name.toLowerCase().includes('add-on');
}
