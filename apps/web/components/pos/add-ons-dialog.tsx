'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
   * Size group) keeps the original per-choice quantity allocator untouched.
   */
  simplified: boolean;
}

/** groupId -> selected option ids (simplified/Add-ons groups only). */
export type AddOnSelections = Record<string, string[]>;

interface AddOnsDialogProps {
  productName: string;
  variantName: string;
  groups: AddOnsDialogGroup[];
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  assignments: AddOnAssignments;
  onAssignmentChange: (groupId: string, choiceKey: string, quantity: number) => void;
  selectedOptionIds: AddOnSelections;
  onToggleOption: (groupId: string, optionId: string) => void;
  onClearGroup: (groupId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Task 108 — same dialog, reopened from an existing cart line via "Edit"; only changes the confirm button's label. */
  isEditMode?: boolean;
}

/**
 * Task 107 — collects add-on choices BEFORE the item reaches the cart.
 * Task 108 — this same dialog also reopens (preloaded) when a cashier taps
 * "Edit" on an existing cart line, via isEditMode.
 *
 * Task 131 — split into two rendering modes per group:
 *  - simplified (Add-ons) groups: optional multi-select checkboxes, no
 *    quantity allocation, "No Add-ons" always available.
 *  - legacy groups (everything else, e.g. Size): unchanged per-choice
 *    quantity allocator, requiring assigned total to equal product quantity
 *    (lib/pos/split-add-ons.ts).
 * The Product Quantity control only appears when at least one legacy group
 * is present — a variant with only Add-ons groups never shows it; quantity
 * for that product is set/changed on the cart line itself instead.
 */
export function AddOnsDialog({
  productName,
  variantName,
  groups,
  quantity,
  onQuantityChange,
  assignments,
  onAssignmentChange,
  selectedOptionIds,
  onToggleOption,
  onClearGroup,
  onCancel,
  onConfirm,
  isEditMode = false,
}: AddOnsDialogProps) {
  const simplifiedGroups = groups.filter((group) => group.simplified);
  const legacyGroups = groups.filter((group) => !group.simplified);

  const isValid = quantity > 0 && legacyGroups.every((group) => assignedQuantity(assignments[group.id]) === quantity);

  function bump(groupId: string, choiceKey: string, delta: number, current: number) {
    const next = current + delta;
    if (next < 0) return;
    onAssignmentChange(groupId, choiceKey, next);
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="max-h-[85vh] space-y-4 overflow-y-auto p-4">
          <div>
            <p className="font-medium">{productName}</p>
            <p className="text-xs text-muted-foreground">{variantName}</p>
          </div>

          {legacyGroups.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Quantity</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="touch-target h-7 w-7 p-0"
                  aria-label="Decrease quantity"
                  onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
                >
                  −
                </Button>
                <span className="w-6 text-center tabular-nums">{quantity}</span>
                <Button
                  type="button"
                  variant="outline"
                  className="touch-target h-7 w-7 p-0"
                  aria-label="Increase quantity"
                  onClick={() => onQuantityChange(quantity + 1)}
                >
                  +
                </Button>
              </div>
            </div>
          )}

          {simplifiedGroups.map((group) => {
            const selected = selectedOptionIds[group.id] ?? [];
            return (
              <div key={group.id} className="space-y-2 border-t pt-3">
                <p className="text-sm font-semibold">{group.label}</p>

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={selected.length === 0} onCheckedChange={() => onClearGroup(group.id)} />
                  No Add-ons
                </label>

                {group.options.map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.includes(option.id)}
                      onCheckedChange={() => onToggleOption(group.id, option.id)}
                    />
                    {option.name}
                    {option.price_adjustment !== 0 ? formatAdjustment(option.price_adjustment) : ''}
                  </label>
                ))}
              </div>
            );
          })}

          {legacyGroups.map((group) => {
            const groupAssignment = assignments[group.id] ?? {};
            const assigned = assignedQuantity(groupAssignment);
            return (
              <div key={group.id} className="space-y-2 border-t pt-3">
                <p className="text-sm font-semibold">{group.label}</p>

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

                <p className={`text-xs ${assigned === quantity ? 'text-muted-foreground' : 'font-medium text-destructive'}`}>
                  Assigned {assigned} / {quantity}
                </p>
              </div>
            );
          })}

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" className="flex-1" disabled={!isValid} onClick={onConfirm}>
              {isEditMode ? 'Save' : 'Add'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
