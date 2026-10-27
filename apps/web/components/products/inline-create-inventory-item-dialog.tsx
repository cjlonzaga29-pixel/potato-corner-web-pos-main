'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { FormSaveError } from '@/components/shared/forms/form-save-error';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  useInventoryCategories,
  useUnitsOfMeasure,
  useCreateInventoryItem,
} from '@/hooks/queries/use-universal-inventory';

interface InlineCreateInventoryItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires with the newly created item's id once creation succeeds, so the caller can select it without losing anything else it had already entered. */
  onCreated: (itemId: string) => void;
}

/**
 * POS-PERF-P36 — "Allow authorized inline item creation without losing the
 * draft": a minimal InventoryItem creation form that opens on top of the
 * Recipe/BOM component picker so a supervisor who can't find "Raw Fries" or
 * "Small Cup" in the list doesn't have to abandon the product builder step
 * they're on to go create it elsewhere. Unit is a UnitOfMeasure (g/kg/pc) —
 * never invented here, only selected from the existing stable list; a "cup"
 * stays an InventoryItem, never a unit.
 */
export function InlineCreateInventoryItemDialog({
  open,
  onOpenChange,
  onCreated,
}: InlineCreateInventoryItemDialogProps) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [baseUnitId, setBaseUnitId] = useState('');

  const { data: categories, isLoading: categoriesLoading } = useInventoryCategories();
  const { data: units, isLoading: unitsLoading } = useUnitsOfMeasure();
  const createItem = useCreateInventoryItem();

  function reset() {
    setName('');
    setCategoryId('');
    setBaseUnitId('');
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  // POS-PERF-P41 — Back/Escape in the product editor ask before discarding these.
  const hasUnsavedInput = open && (name.trim().length > 0 || Boolean(categoryId) || Boolean(baseUnitId));
  useEffect(() => {
    if (open) createItem.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a stale error is cleared each time the form opens
  }, [open]);

  async function handleSubmit() {
    let created;
    try {
      created = await createItem.mutateAsync({
        name: name.trim(),
        category_id: categoryId || undefined,
        base_unit_id: baseUnitId,
      });
    } catch {
      // Shown inline (FormSaveError); the entered values stay.
      return;
    }
    reset();
    onOpenChange(false);
    onCreated(created.id);
  }

  const isValid = name.trim().length > 0 && Boolean(baseUnitId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm" hasUnsavedInput={hasUnsavedInput}>
        <DialogHeader>
          <DialogTitle>New Inventory Item</DialogTitle>
          <DialogDescription>
            e.g. &quot;Raw Fries&quot;, &quot;Small Cup&quot;, &quot;Cheese Powder&quot;. This becomes available
            everywhere items are picked.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inline-item-name">Item Name</Label>
            <Input
              id="inline-item-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Raw Fries"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="inline-item-category">Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId} disabled={categoriesLoading}>
              <SelectTrigger id="inline-item-category">
                <SelectValue
                  placeholder={categoriesLoading ? 'Loading…' : 'Food / Packaging / Flavor Powder'}
                />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="inline-item-unit">Unit</Label>
            <Select value={baseUnitId} onValueChange={setBaseUnitId} disabled={unitsLoading}>
              <SelectTrigger id="inline-item-unit">
                <SelectValue placeholder={unitsLoading ? 'Loading…' : 'g / kg / pc'} />
              </SelectTrigger>
              <SelectContent>
                {(units ?? []).map((unit) => (
                  <SelectItem key={unit.id} value={unit.id}>
                    {unit.code} — {unit.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              A measurement unit only — &quot;cup&quot; is an item, not a unit.
            </p>
          </div>
        </div>

        <FormSaveError error={createItem.error} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!isValid || createItem.isPending}
          >
            {createItem.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
