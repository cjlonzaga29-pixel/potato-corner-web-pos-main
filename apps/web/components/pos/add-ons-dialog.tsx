'use client';

import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { OptionChoiceCard } from '@/components/pos/option-choice-card';
import {
  CUSTOMIZATION_CHOICE_GRID,
  CUSTOMIZATION_DIALOG_BODY,
  CUSTOMIZATION_DIALOG_CONTENT,
  CUSTOMIZATION_DIALOG_FOOTER,
  CUSTOMIZATION_DIALOG_HEADER,
} from '@/components/pos/customization-dialog-layout';
import { cn } from '@/lib/utils';
import { chosenQuantity, type AddOnAssignments, type AddOnSplitGroup } from '@/lib/pos/split-add-ons';

export interface AddOnsDialogGroup extends AddOnSplitGroup {
  label: string;
  /**
   * P46 — the group is optional (not required, min_selections 0 — the same
   * minimum the publication check uses): picking nothing means no add-ons,
   * with no "No Add-ons" choice to tap first.
   */
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
  /** P46 — one more (+1) or one fewer (-1) of an option in a MULTIPLE group; the owner applies it to its latest state and clamps it to the group's limit, so rapid taps can't overshoot. */
  onAdjustAssignment: (groupId: string, optionId: string, delta: 1 | -1) => void;
  selectedOptionIds: AddOnSelections;
  onToggleOption: (groupId: string, optionId: string) => void;
  onSelectOption: (groupId: string, optionId: string) => void;
  onClearGroup: (groupId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Task 108 — same dialog, reopened from an existing cart line via "Edit"; only changes the confirm button's label. */
  isEditMode?: boolean;
  /** P46 — where focus goes when the dialog closes, for an opener (a flavor picker) that is itself gone by then. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** How many picks a MULTIPLE group's allocator must sum to — the group's own required count, independent of product quantity (Task 182). */
export function multiGroupTarget(group: AddOnsDialogGroup): number {
  return group.maxSelections ?? Math.max(group.minSelections, 1);
}

/** P46 — a required MULTIPLE group must be filled exactly; an optional one may hold anything from nothing up to its target. */
export function isMultiGroupComplete(group: AddOnsDialogGroup, assignment: Record<string, number> | undefined): boolean {
  const picked = chosenQuantity(assignment);
  const target = multiGroupTarget(group);
  return group.allowNoAddOn ? picked <= target : picked === target;
}

function GroupHeading({ id, label, hint, badge }: { id: string; label: string; hint: string; badge?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 id={id} className="break-words text-sm font-semibold">
          {label}
        </h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {badge}
    </div>
  );
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
 * required Flavor choice) renders one row per option with single-select
 * behavior and no allocator; MULTIPLE keeps the quantity allocator, sized to
 * the group's own required count. The top-level product Quantity control is
 * gone entirely — a new item always starts at cart quantity 1; editing
 * preserves the cart line's existing quantity; quantity is only ever changed
 * from the cart itself.
 *
 * Tasks 196/220/209.8B/209.56C — sticky header/footer, a wider dialog,
 * per-group progress, and rows that wrap long names (min-w-0/break-words on
 * every name, shrink-0 on every control column) instead of overflowing.
 *
 * P46 (owner video review) —
 * - Layout: full screen on a phone; from `sm` a wide, height-capped dialog.
 *   The header (product, size, Close) and footer (Cancel/Add) are fixed
 *   rows of a flex column and only the choices between them scroll, so the
 *   actions never scroll away or cover the last choice.
 * - Every choice is an OptionChoiceCard: the whole card is the tap target.
 *   Single-choice groups replace the pick (an optional one also un-picks on
 *   a second tap); Add-ons groups toggle; MULTIPLE groups add one per tap
 *   with a ×N badge and a separate Remove-one control.
 * - "No Add-ons" is no longer something to pick: an optional group left
 *   empty is valid and means no add-ons. An optional MULTIPLE group's
 *   unpicked remainder is filled with no-add-on units on confirm (the page,
 *   via fillWithNoAddOn), so the cart lines are what the old flow produced.
 *   Required groups are exactly as strict as before.
 * - Focus containment and Escape come from the Radix dialog unchanged.
 */
export function AddOnsDialog({
  productName,
  variantName,
  groups,
  quantity,
  assignments,
  onAdjustAssignment,
  selectedOptionIds,
  onToggleOption,
  onSelectOption,
  onClearGroup,
  onCancel,
  onConfirm,
  isEditMode = false,
  onCloseAutoFocus,
}: AddOnsDialogProps) {
  const headingIdPrefix = useId();
  const simplifiedGroups = groups.filter((group) => group.simplified);
  const singleGroups = groups.filter((group) => !group.simplified && group.selectionType === 'SINGLE');
  const multiGroups = groups.filter((group) => !group.simplified && group.selectionType === 'MULTIPLE');

  const missingRequired = singleGroups.filter((group) => group.required && (selectedOptionIds[group.id] ?? []).length !== 1);
  const incompleteMulti = multiGroups.filter((group) => !isMultiGroupComplete(group, assignments[group.id]));
  const isValid = quantity > 0 && missingRequired.length === 0 && incompleteMulti.length === 0;
  const blockingLabels = [...missingRequired, ...incompleteMulti].map((group) => group.label);
  // A lone MULTIPLE group is split one unit per pick up to its target (Task 182; the page's handleAddOnsConfirm), so say so rather than add several items silently.
  const splitGroup = multiGroups.length === 1 ? multiGroups[0] : undefined;
  const unitsAdded = splitGroup ? multiGroupTarget(splitGroup) : quantity;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className={CUSTOMIZATION_DIALOG_CONTENT}
      >
        <DialogHeader className={CUSTOMIZATION_DIALOG_HEADER}>
          <DialogTitle className="break-words text-lg leading-tight sm:text-xl">{productName}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground">{variantName}</span>
            {isEditMode && <span className="text-xs">Editing cart item</span>}
          </DialogDescription>
        </DialogHeader>

        <div data-testid="add-ons-scroll-region" className={CUSTOMIZATION_DIALOG_BODY}>
          {singleGroups.map((group) => {
            const selectedId = (selectedOptionIds[group.id] ?? [])[0];
            const headingId = `${headingIdPrefix}-${group.id}`;
            return (
              <section key={group.id} role="group" aria-labelledby={headingId} className="min-w-0 space-y-2">
                <GroupHeading
                  id={headingId}
                  label={group.label}
                  hint={group.required ? 'Choose 1' : 'Optional — choose 1 or leave empty'}
                  badge={
                    group.required ? (
                      <Badge variant={selectedId ? 'active' : 'warning'} className="shrink-0 text-[10px] font-medium">
                        {selectedId ? 'Selected' : 'Required'}
                      </Badge>
                    ) : undefined
                  }
                />
                <div className={CUSTOMIZATION_CHOICE_GRID}>
                  {group.options.map((option) => {
                    const isSelected = selectedId === option.id;
                    return (
                      <OptionChoiceCard
                        key={option.id}
                        name={option.name}
                        priceAdjustment={option.price_adjustment}
                        selected={isSelected}
                        onActivate={() => {
                          if (isSelected) {
                            if (!group.required) onClearGroup(group.id);
                            return;
                          }
                          onSelectOption(group.id, option.id);
                        }}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}

          {multiGroups.map((group) => {
            const target = multiGroupTarget(group);
            const groupAssignment = assignments[group.id] ?? {};
            const assigned = chosenQuantity(groupAssignment);
            const atLimit = assigned >= target;
            const complete = isMultiGroupComplete(group, groupAssignment);
            const headingId = `${headingIdPrefix}-${group.id}`;
            return (
              <section key={group.id} role="group" aria-labelledby={headingId} className="min-w-0 space-y-2">
                <GroupHeading
                  id={headingId}
                  label={group.label}
                  hint={group.allowNoAddOn ? `Optional — up to ${target}. Leave empty for none.` : `Tap to add. Choose ${target} in total.`}
                  badge={
                    group.allowNoAddOn ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px] font-medium">
                        Optional
                      </Badge>
                    ) : (
                      <Badge variant={complete ? 'active' : 'warning'} className="shrink-0 text-[10px] font-medium">
                        {complete ? 'Complete' : `Choose ${target}`}
                      </Badge>
                    )
                  }
                />
                <div className={CUSTOMIZATION_CHOICE_GRID}>
                  {group.options.map((option) => (
                    <OptionChoiceCard
                      key={option.id}
                      name={option.name}
                      priceAdjustment={option.price_adjustment}
                      quantity={groupAssignment[option.id] ?? 0}
                      addDisabled={atLimit}
                      onActivate={() => onAdjustAssignment(group.id, option.id, 1)}
                      onDecrement={() => onAdjustAssignment(group.id, option.id, -1)}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                    <div
                      className={cn('h-full transition-all', atLimit ? 'bg-success' : 'bg-primary')}
                      style={{ width: `${target > 0 ? Math.min(100, (assigned / target) * 100) : 0}%` }}
                    />
                  </div>
                  <p className={cn('shrink-0 text-xs', complete ? 'text-muted-foreground' : 'font-medium text-destructive')}>
                    Assigned {assigned} / {target}
                  </p>
                </div>
              </section>
            );
          })}

          {simplifiedGroups.map((group) => {
            const selected = selectedOptionIds[group.id] ?? [];
            const headingId = `${headingIdPrefix}-${group.id}`;
            return (
              <section key={group.id} role="group" aria-labelledby={headingId} className="min-w-0 space-y-2">
                <GroupHeading
                  id={headingId}
                  label={group.label}
                  hint="Optional — tap to add, tap again to remove. Leave empty for no add-ons."
                  badge={
                    selected.length > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 px-2 text-xs"
                        aria-label={`Clear ${group.label}`}
                        onClick={() => onClearGroup(group.id)}
                      >
                        Clear
                      </Button>
                    ) : (
                      <Badge variant="secondary" className="shrink-0 text-[10px] font-medium">
                        Optional
                      </Badge>
                    )
                  }
                />
                <div className={CUSTOMIZATION_CHOICE_GRID}>
                  {group.options.map((option) => (
                    <OptionChoiceCard
                      key={option.id}
                      name={option.name}
                      priceAdjustment={option.price_adjustment}
                      selected={selected.includes(option.id)}
                      onActivate={() => onToggleOption(group.id, option.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <DialogFooter className={CUSTOMIZATION_DIALOG_FOOTER}>
          {!isValid && blockingLabels.length > 0 && (
            <p className="text-xs font-medium text-destructive" aria-live="polite">
              Still needed: {blockingLabels.join(', ')}
            </p>
          )}
          {splitGroup && unitsAdded > 1 && (
            <p className="text-xs text-muted-foreground">
              {isEditMode ? 'Saves' : 'Adds'} {unitsAdded} items — one per {splitGroup.label} pick{splitGroup.allowNoAddOn ? '; any left empty have none' : ''}.
            </p>
          )}
          <div className="flex w-full gap-2">
            <Button type="button" variant="outline" className="touch-target h-12 flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" className="touch-target h-12 flex-1" disabled={!isValid} onClick={onConfirm}>
              {isEditMode ? 'Save' : 'Add'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
