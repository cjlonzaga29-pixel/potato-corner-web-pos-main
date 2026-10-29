import { servingCountGroup, type AddOnsDialogGroup } from '@/components/pos/add-ons-dialog';
import type { PosCartItem } from '@/stores/cart.store';

/**
 * P46R3 — checkout refusals caused by the product's option configuration.
 * Edit Cart re-reads the catalog from the network before reopening the cart
 * after one of these, since the terminal's copy is what built the bad line.
 */
const OPTION_CONFIG_ERROR_CODES = new Set(['PRODUCT_OPTION_REQUIRED', 'PRODUCT_OPTION_LIMIT_EXCEEDED', 'PRODUCT_OPTION_NOT_AVAILABLE']);

export function isOptionConfigErrorCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && OPTION_CONFIG_ERROR_CODES.has(code);
}

/**
 * What a cart line still needs under the given (freshly read) option groups,
 * or [] when the server would accept it. `groups` null means the variant is
 * no longer sellable here. Mirrors the server's per-line rules
 * (transactions.service.ts resolveSelectedOptions, P46R2 runbook §5.2):
 * Add-ons-named groups need nothing; a required SINGLE group one pick; the
 * serving-count group one pick per line (the POS splits it per unit); any
 * other required MULTIPLE group its configured minimum; maxima as the dialog
 * enforces them. Nothing is changed or substituted — this only reports.
 */
export function reviewCartLineOptions(item: PosCartItem, groups: AddOnsDialogGroup[] | null): string[] {
  if (!groups) return ['No longer available at this branch'];
  const problems: string[] = [];
  const selected = item.selected_options ?? [];
  const offered = new Set(groups.flatMap((group) => group.options.map((option) => option.id)));
  const gone = [...new Set(selected.filter((option) => !offered.has(option.option_id)).map((option) => option.option_name))];
  for (const name of gone) problems.push(`${name} is no longer offered`);

  const serving = servingCountGroup(groups);
  for (const group of groups) {
    const ids = new Set(group.options.map((option) => option.id));
    const picks = selected.filter((option) => ids.has(option.option_id)).length;
    const min = group.simplified
      ? 0
      : group.allowNoAddOn
        ? 0
        : group.selectionType === 'SINGLE' || group === serving
          ? 1
          : Math.max(group.minSelections, group.required ? 1 : 0);
    const max = !group.simplified && group.selectionType === 'SINGLE' ? 1 : group.maxSelections;
    if (picks < min) problems.push(min === 1 ? `Choose ${group.label}` : `Choose ${min} ${group.label}`);
    else if (max !== null && picks > max) problems.push(`Too many ${group.label} (up to ${max})`);
  }
  return problems;
}

/**
 * The same line with each still-offered option's name and price taken from
 * the fresh groups (the cart keeps its own copy for display and the preview
 * total). Choices are never added, removed or swapped; an option no longer
 * offered is left as it was so reviewCartLineOptions keeps reporting it.
 * Returns the same object when nothing changed.
 */
export function refreshCartLineOptionDetails(item: PosCartItem, groups: AddOnsDialogGroup[] | null): PosCartItem {
  if (!groups || !item.selected_options?.length) return item;
  const current = new Map(groups.flatMap((group) => group.options.map((option) => [option.id, option] as const)));
  let changed = false;
  const selected_options = item.selected_options.map((option) => {
    const fresh = current.get(option.option_id);
    if (!fresh || (fresh.name === option.option_name && fresh.price_adjustment === option.price_adjustment)) return option;
    changed = true;
    return { ...option, option_name: fresh.name, price_adjustment: fresh.price_adjustment };
  });
  return changed ? { ...item, selected_options } : item;
}
