'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
}

interface AddOnsDialogProps {
  productName: string;
  variantName: string;
  groups: AddOnsDialogGroup[];
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  assignments: AddOnAssignments;
  onAssignmentChange: (groupId: string, choiceKey: string, quantity: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Task 108 — same dialog, reopened from an existing cart line via "Edit"; only changes the confirm button's label. */
  isEditMode?: boolean;
}

/**
 * Task 107 — collects add-on choices BEFORE the item reaches the cart, one
 * quantity-per-choice per assigned Product Option Group, so the product
 * quantity can be split into independent single-selection cart lines
 * (see lib/pos/split-add-ons.ts). Replaces the old post-cart per-line
 * Add-ons editor — once "Add" is pressed here, a line's add-ons are fixed.
 *
 * Task 108 — this same dialog also reopens (preloaded with the cart line's
 * current quantity/assignments) when a cashier taps "Edit" on an existing
 * cart line, via isEditMode. No separate edit dialog component.
 */
export function AddOnsDialog({
  productName,
  variantName,
  groups,
  quantity,
  onQuantityChange,
  assignments,
  onAssignmentChange,
  onCancel,
  onConfirm,
  isEditMode = false,
}: AddOnsDialogProps) {
  const isValid = groups.every((group) => assignedQuantity(assignments[group.id]) === quantity) && quantity > 0;

  function bump(groupId: string, choiceKey: string, delta: number, current: number) {
    const next = current + delta;
    if (next < 0) return;
    onAssignmentChange(groupId, choiceKey, next);
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="max-h-[85vh] space-y-4 overflow-y-auto p-4">
          <div>
            <p className="font-medium">{productName}</p>
            <p className="text-xs text-muted-foreground">{variantName}</p>
          </div>

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

          {groups.map((group) => {
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
