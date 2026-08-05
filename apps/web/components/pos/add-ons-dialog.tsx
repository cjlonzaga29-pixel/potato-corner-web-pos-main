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
      <DialogContent className="max-w-md">
        <DialogHeader className="sticky top-0 z-10 -mx-4 -mt-4 border-b bg-card px-4 pb-3 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6">
          <DialogTitle>{productName}</DialogTitle>
          <DialogDescription>{variantName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {simplifiedGroups.map((group) => {
            const selected = selectedOptionIds[group.id] ?? [];
            return (
              <div key={group.id} className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{group.label}</p>
                  <Badge variant="secondary" className="text-[10px] font-medium">
                    Optional
                  </Badge>
                </div>

                <label
                  className={cn(
                    'touch-target flex cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm transition-colors',
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
                        'touch-target flex cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm transition-colors',
                        isSelected ? 'border-primary bg-primary/10 font-medium' : 'border-input',
                      )}
                    >
                      <Checkbox checked={isSelected} onCheckedChange={() => onToggleOption(group.id, option.id)} />
                      <span className="flex-1">
                        {option.name}
                        {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                      </span>
                    </label>
                  );
                })}
              </div>
            );
          })}

          {singleGroups.map((group) => {
            const selectedId = (selectedOptionIds[group.id] ?? [])[0];
            return (
              <div key={group.id} className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{group.label}</p>
                  {group.required && (
                    <Badge variant={selectedId ? 'active' : 'warning'} className="text-[10px] font-medium">
                      {selectedId ? 'Selected' : 'Required'}
                    </Badge>
                  )}
                </div>

                <div className="space-y-2">
                  {group.options.map((option) => {
                    const isSelected = selectedId === option.id;
                    return (
                      <label
                        key={option.id}
                        className={cn(
                          'touch-target flex cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm transition-colors',
                          isSelected ? 'border-primary bg-primary/10 font-medium' : 'border-input',
                        )}
                      >
                        <Checkbox checked={isSelected} onCheckedChange={() => onSelectOption(group.id, option.id)} />
                        <span className="flex-1">
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
              <div key={group.id} className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{group.label}</p>
                  {group.required && (
                    <Badge variant={assigned === target ? 'active' : 'warning'} className="text-[10px] font-medium">
                      {assigned === target ? 'Complete' : `Choose ${target}`}
                    </Badge>
                  )}
                </div>

                {group.allowNoAddOn && (
                  <div className="flex items-center justify-between text-sm">
                    <span>No Add-ons</span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="touch-target h-7 w-7 p-0"
                        aria-label="Decrease No Add-ons quantity"
                        onClick={() => bump(group.id, NO_ADD_ON_KEY, -1, groupAssignment[NO_ADD_ON_KEY] ?? 0)}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center tabular-nums">{groupAssignment[NO_ADD_ON_KEY] ?? 0}</span>
                      <Button
                        type="button"
                        variant="outline"
                        className="touch-target h-7 w-7 p-0"
                        aria-label="Increase No Add-ons quantity"
                        onClick={() => bump(group.id, NO_ADD_ON_KEY, 1, groupAssignment[NO_ADD_ON_KEY] ?? 0)}
                      >
                        +
                      </Button>
                    </div>
                  </div>
                )}

                {group.options.map((option) => (
                  <div key={option.id} className="flex items-center justify-between text-sm">
                    <span>
                      {option.name}
                      {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="touch-target h-7 w-7 p-0"
                        aria-label={`Decrease ${option.name} quantity`}
                        onClick={() => bump(group.id, option.id, -1, groupAssignment[option.id] ?? 0)}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center tabular-nums">{groupAssignment[option.id] ?? 0}</span>
                      <Button
                        type="button"
                        variant="outline"
                        className="touch-target h-7 w-7 p-0"
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

        <DialogFooter className="sticky bottom-0 z-10 -mx-4 -mb-4 flex-row gap-2 border-t bg-card px-4 pb-4 pt-3 sm:-mx-6 sm:-mb-6 sm:justify-normal sm:px-6 sm:pb-6">
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
