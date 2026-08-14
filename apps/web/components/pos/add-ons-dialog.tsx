'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { NO_ADD_ON_KEY, assignedQuantity, type AddOnAssignments, type AddOnSplitGroup } from '@/lib/pos/split-add-ons';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

function formatAdjustment(amount: number): string {
  return amount >= 0 ? ` (+${formatPeso(amount)})` : ` (-${formatPeso(Math.abs(amount))})`;
}

export interface AddOnsDialogGroup extends AddOnSplitGroup {
  label: string;
  allowNoAddOn: boolean;
  /**
   * Task 131 — groups matching the POS Add-ons naming rule (see
   * lib/pos/split-add-ons.ts#isAddOnsGroup) render as an optional
   * multi-select checklist: zero or many options, applied once per product
   * unit, no quantity allocation. Every other group (e.g. a SINGLE-selection
   * Flavor/Size group) is split further by selectionType below.
   */
  simplified: boolean;
  /**
   * Task 182 — a SINGLE-selection group (typically a required Flavor/Size
   * choice) renders as one checkbox-style row per option with radio
   * (single-select) behavior — no quantity allocator. A MULTIPLE-selection
   * group keeps the per-choice quantity allocator, sized against the
   * group's own required count (minSelections/maxSelections) rather than
   * the removed top-level product quantity.
   */
  selectionType: 'SINGLE' | 'MULTIPLE';
  required: boolean;
  minSelections: number;
  maxSelections: number | null;
}

/** groupId -> selected option ids (simplified/Add-ons groups and SINGLE-selection groups). */
export type AddOnSelections = Record<string, string[]>;

interface AddOnsDialogProps {
  productName: string;
  variantName: string;
  groups: AddOnsDialogGroup[];
  /** Cart line quantity — 1 on a new add, preserved unchanged on edit. Never adjustable from this dialog (Task 182); the cart owns quantity. */
  quantity: number;
  assignments: AddOnAssignments;
  onAssignmentChange: (groupId: string, choiceKey: string, quantity: number) => void;
  selectedOptionIds: AddOnSelections;
  onToggleOption: (groupId: string, optionId: string) => void;
  onSelectOption: (groupId: string, optionId: string) => void;
  onClearGroup: (groupId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Task 108 — same dialog, reopened from an existing cart line via "Edit"; only changes the confirm button's label. */
  isEditMode?: boolean;
}

/** How many picks a MULTIPLE group's allocator must sum to — the group's own required count, independent of product quantity (Task 182). */
export function multiGroupTarget(group: AddOnsDialogGroup): number {
  return group.maxSelections ?? Math.max(group.minSelections, 1);
}

/**
 * Task 107 — collects add-on choices BEFORE the item reaches the cart.
 * Task 108 — this same dialog also reopens (preloaded) when a cashier taps
 * "Edit" on an existing cart line, via isEditMode.
 *
 * Task 131 — split into two rendering modes per group: simplified (Add-ons)
 * groups get an optional multi-select checklist; every other (legacy) group
 * keeps a per-choice allocator.
 *
 * Task 182 — legacy groups split further by selectionType: SINGLE (e.g. a
 * required Flavor choice) renders one checkbox-style row per option with
 * single-select behavior and no allocator; MULTIPLE keeps the quantity
 * allocator, now sized to the group's own required count. The top-level
 * product Quantity control is gone entirely — a new item always starts at
 * cart quantity 1; editing preserves the cart line's existing quantity;
 * quantity is only ever changed from the cart itself.
 *
 * Task 196 (visual redesign) — sticky header/footer within the dialog's
 * existing scroll container (DialogContent already carries
 * max-h-[calc(100vh-2rem)]/overflow-y-auto/w-[calc(100vw-2rem)] from the base
 * component — untouched here, only className="max-w-md" narrows it), a
 * required-selection progress readout per group, and card-style highlighting
 * for every selected/checked row. Every group's selection logic, isValid
 * rule, and the exact "Assigned N / M" text are unchanged.
 *
 * Task 220 (options dialog usability) — widened the dialog from max-w-md
 * (28rem) to w-[min(92vw,720px)] so a product with many flavor/add-on groups
 * has room to breathe instead of wrapping every long label; max-h-[min(88vh,850px)]
 * bounds it on very tall viewports the same way the previous max-h-[calc(100vh-2rem)]
 * did on short ones. overflow-x-hidden is explicit (not just relied-upon
 * wrapping) so a future long unbroken token can't reopen a horizontal
 * scrollbar. Checkbox-style rows (simplified/SINGLE groups) render in a
 * 2-column grid at sm+ to use the extra width instead of stacking full-height
 * rows; MULTIPLE-group allocator rows stay single-column since their +/-
 * controls need the full row width. Selection logic, isValid rule, and
 * payload shape are unchanged.
 *
 * Task 209.8B — tighter vertical rhythm: option/choice rows moved off the
 * fixed-48px `.touch-target` onto the density-aware `.app-control`
 * (option rows) / `.app-control-square` (allocator +/- buttons), smaller
 * inter-group spacing, and slightly reduced header/footer padding. Group
 * ordering, selection semantics, and payload shape are unchanged.
 *
 * Task 209.56C — checkbox-style rows (simplified/single-selection) swapped
 * `.app-control`'s fixed `height` for `min-h-[var(--app-control-height)]
 * h-auto py-2`: a long flavor/add-on name wrapping to 2+ lines used to
 * either clip against the row's fixed height or overlap the row below it
 * instead of growing the row. Every option-name `<span>` (both those rows
 * and the MULTIPLE-group allocator rows) gained `min-w-0 flex-1
 * break-words`, and every counter/button column gained `shrink-0` — a flex
 * child's default min-width is its own max-content width, which without
 * this can push the row (and the dialog) wider than its container instead
 * of wrapping, the root cause of a horizontal scrollbar on a long option
 * name. Purely geometric; selection logic and payload shape are unchanged.
 */
export function AddOnsDialog({
  productName,
  variantName,
  groups,
  quantity,
  assignments,
  onAssignmentChange,
  selectedOptionIds,
  onToggleOption,
  onSelectOption,
  onClearGroup,
  onCancel,
  onConfirm,
  isEditMode = false,
}: AddOnsDialogProps) {
  const simplifiedGroups = groups.filter((group) => group.simplified);
  const singleGroups = groups.filter((group) => !group.simplified && group.selectionType === 'SINGLE');
  const multiGroups = groups.filter((group) => !group.simplified && group.selectionType === 'MULTIPLE');

  const isValid =
    quantity > 0 &&
    singleGroups.filter((group) => group.required).every((group) => (selectedOptionIds[group.id] ?? []).length === 1) &&
    multiGroups.every((group) => assignedQuantity(assignments[group.id]) === multiGroupTarget(group));

  function bump(groupId: string, choiceKey: string, delta: number, current: number) {
    const next = current + delta;
    if (next < 0) return;
    onAssignmentChange(groupId, choiceKey, next);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="w-[min(92vw,720px)] max-w-[720px] max-h-[min(88vh,850px)] overflow-x-hidden">
        <DialogHeader className="sticky top-0 z-10 -mx-4 -mt-4 border-b bg-card px-4 pb-2.5 pt-3.5 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-5">
          <DialogTitle>{productName}</DialogTitle>
          <DialogDescription>{variantName}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3 py-1">
          {simplifiedGroups.map((group) => {
            const selected = selectedOptionIds[group.id] ?? [];
            return (
              <div key={group.id} className="min-w-0 space-y-1.5 border-t pt-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{group.label}</p>
                  <Badge variant="secondary" className="text-[10px] font-medium">
                    Optional
                  </Badge>
                </div>

                {/* Task 220 — 2-column at sm+ so the wider dialog isn't wasted on a
                    single narrow column of short checkbox rows; each row still wraps
                    independently via min-w-0/break-words below. */}
                <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <label
                    className={cn(
                      // Task 209.56C — was the fixed-height `app-control` (a
                      // single `height` token, no wrapping headroom); a
                      // min-height + h-auto lets a row that wraps to 2+ lines
                      // (a long flavor/add-on name) grow instead of clipping
                      // or overlapping the row below it.
                      'flex min-h-[var(--app-control-height)] h-auto min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                      selected.length === 0 ? 'border-primary bg-primary/10 font-medium' : 'border-input',
                    )}
                  >
                    <Checkbox checked={selected.length === 0} onCheckedChange={() => onClearGroup(group.id)} />
                    No Add-ons
                  </label>

                  {group.options.map((option) => {
                    const isSelected = selected.includes(option.id);
                    return (
                      <label
                        key={option.id}
                        className={cn(
                          'flex min-h-[var(--app-control-height)] h-auto min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                          isSelected ? 'border-primary bg-primary/10 font-medium' : 'border-input',
                        )}
                      >
                        <Checkbox checked={isSelected} onCheckedChange={() => onToggleOption(group.id, option.id)} />
                        {/* Task 209.56C — min-w-0 is required alongside flex-1: a
                            flex child's default min-width is its content's max-content
                            width, which without this can push the row wider than the
                            dialog instead of wrapping (the horizontal-scrollbar cause
                            for a long, mostly-unbroken option name). */}
                        <span className="min-w-0 flex-1 break-words">
                          {option.name}
                          {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {singleGroups.map((group) => {
            const selectedId = (selectedOptionIds[group.id] ?? [])[0];
            return (
              <div key={group.id} className="min-w-0 space-y-1.5 border-t pt-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{group.label}</p>
                  {group.required && (
                    <Badge variant={selectedId ? 'active' : 'warning'} className="text-[10px] font-medium">
                      {selectedId ? 'Selected' : 'Required'}
                    </Badge>
                  )}
                </div>

                <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {group.options.map((option) => {
                    const isSelected = selectedId === option.id;
                    return (
                      <label
                        key={option.id}
                        className={cn(
                          'flex min-h-[var(--app-control-height)] h-auto min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                          isSelected ? 'border-primary bg-primary/10 font-medium' : 'border-input',
                        )}
                      >
                        <Checkbox checked={isSelected} onCheckedChange={() => onSelectOption(group.id, option.id)} />
                        <span className="min-w-0 flex-1 break-words">
                          {option.name}
                          {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {multiGroups.map((group) => {
            const target = multiGroupTarget(group);
            const groupAssignment = assignments[group.id] ?? {};
            const assigned = assignedQuantity(groupAssignment);
            return (
              <div key={group.id} className="space-y-1.5 border-t pt-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{group.label}</p>
                  {group.required && (
                    <Badge variant={assigned === target ? 'active' : 'warning'} className="text-[10px] font-medium">
                      {assigned === target ? 'Complete' : `Choose ${target}`}
                    </Badge>
                  )}
                </div>

                {group.allowNoAddOn && (
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 flex-1 break-words">No Add-ons</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="app-control-square p-0"
                        aria-label="Decrease No Add-ons quantity"
                        onClick={() => bump(group.id, NO_ADD_ON_KEY, -1, groupAssignment[NO_ADD_ON_KEY] ?? 0)}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center tabular-nums">{groupAssignment[NO_ADD_ON_KEY] ?? 0}</span>
                      <Button
                        type="button"
                        variant="outline"
                        className="app-control-square p-0"
                        aria-label="Increase No Add-ons quantity"
                        onClick={() => bump(group.id, NO_ADD_ON_KEY, 1, groupAssignment[NO_ADD_ON_KEY] ?? 0)}
                      >
                        +
                      </Button>
                    </div>
                  </div>
                )}

                {group.options.map((option) => (
                  <div key={option.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 flex-1 break-words">
                      {option.name}
                      {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="app-control-square p-0"
                        aria-label={`Decrease ${option.name} quantity`}
                        onClick={() => bump(group.id, option.id, -1, groupAssignment[option.id] ?? 0)}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center tabular-nums">{groupAssignment[option.id] ?? 0}</span>
                      <Button
                        type="button"
                        variant="outline"
                        className="app-control-square p-0"
                        aria-label={`Increase ${option.name} quantity`}
                        onClick={() => bump(group.id, option.id, 1, groupAssignment[option.id] ?? 0)}
                      >
                        +
                      </Button>
                    </div>
                  </div>
                ))}

                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                  <div
                    className={cn('h-full transition-all', assigned >= target ? 'bg-success' : 'bg-primary')}
                    style={{ width: `${target > 0 ? Math.min(100, (assigned / target) * 100) : 0}%` }}
                  />
                </div>
                <p className={`text-xs ${assigned === target ? 'text-muted-foreground' : 'font-medium text-destructive'}`}>
                  Assigned {assigned} / {target}
                </p>
              </div>
            );
          })}
        </div>

        <DialogFooter className="sticky bottom-0 z-10 -mx-4 -mb-4 flex-row gap-2 border-t bg-card px-4 pb-3.5 pt-2.5 sm:-mx-6 sm:-mb-6 sm:justify-normal sm:px-6 sm:pb-5">
          <Button type="button" variant="outline" className="touch-target flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" className="touch-target flex-1" disabled={!isValid} onClick={onConfirm}>
            {isEditMode ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
