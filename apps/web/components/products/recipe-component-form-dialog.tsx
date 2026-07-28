'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductComponentResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useInventoryItems } from '@/hooks/queries/use-universal-inventory';
import { useCreateProductComponent, useUpdateProductComponent } from '@/hooks/queries/use-product-components';

interface RecipeComponentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productVariantId: string;
  existingComponents: ProductComponentResponse[];
  editingComponent?: ProductComponentResponse;
}

/**
 * Create/edit one ProductComponent Recipe/BOM row (CR-011.1). Editing only
 * allows changing quantity, matching updateProductComponentSchema — the
 * inventory item and its unit (the item's base unit — no per-component
 * override) are fixed once created.
 *
 * useInventoryItems(false) (includeInactive=false, the default) already
 * excludes soft-deleted/inactive items from the picker, so an inactive item
 * can't be selected here.
 */
export function RecipeComponentFormDialog({
  open,
  onOpenChange,
  productVariantId,
  existingComponents,
  editingComponent,
}: RecipeComponentFormDialogProps) {
  const isEdit = Boolean(editingComponent);

  const [inventoryItemId, setInventoryItemId] = useState('');
  const [quantityRequired, setQuantityRequired] = useState('');

  const createComponent = useCreateProductComponent(productVariantId);
  const updateComponent = useUpdateProductComponent(productVariantId, editingComponent?.id ?? '');
  const mutation = isEdit ? updateComponent : createComponent;

  const { data: inventoryItems, isLoading: itemsLoading } = useInventoryItems(false);

  useEffect(() => {
    if (!open) return;
    if (editingComponent) {
      setInventoryItemId(editingComponent.inventory_item_id);
      setQuantityRequired(String(editingComponent.quantity_required));
    } else {
      setInventoryItemId('');
      setQuantityRequired('');
    }
  }, [open, editingComponent]);

  const usedItemIds = new Set(existingComponents.map((component) => component.inventory_item_id));
  const availableItems = (inventoryItems ?? []).filter((item) => !usedItemIds.has(item.id));
  const selectedUnit = isEdit
    ? editingComponent?.base_unit_code
    : inventoryItems?.find((item) => item.id === inventoryItemId)?.base_unit_code;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function handleSubmit() {
    const numericQuantity = Number(quantityRequired);
    if (isEdit) {
      await updateComponent.mutateAsync({ quantity_required: numericQuantity });
    } else {
      if (!inventoryItemId) return;
      await createComponent.mutateAsync({
        product_variant_id: productVariantId,
        inventory_item_id: inventoryItemId,
        quantity_required: numericQuantity,
      });
    }
    handleOpenChange(false);
  }

  const isValid = (isEdit || Boolean(inventoryItemId)) && quantityRequired !== '' && Number(quantityRequired) > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Recipe Component' : 'Add Recipe Component'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Quantity is the only field that can change after a component is added.'
              : 'Choose an inventory item and how much of it this variant consumes.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isEdit ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{editingComponent?.inventory_item_name}</p>
              {editingComponent?.inventory_item_sku && <p className="text-muted-foreground">SKU: {editingComponent.inventory_item_sku}</p>}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="recipe-component-item">Inventory Item</Label>
              <Select value={inventoryItemId} onValueChange={setInventoryItemId} disabled={itemsLoading}>
                <SelectTrigger id="recipe-component-item">
                  <SelectValue placeholder={itemsLoading ? 'Loading…' : 'Select an inventory item'} />
                </SelectTrigger>
                <SelectContent>
                  {availableItems.length === 0 && !itemsLoading ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No available inventory items to add</div>
                  ) : (
                    availableItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="recipe-component-quantity">Quantity Required</Label>
              <Input
                id="recipe-component-quantity"
                type="number"
                min="0"
                step="0.0001"
                value={quantityRequired}
                onChange={(event) => setQuantityRequired(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Unit</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                {selectedUnit ?? '—'}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!isValid || mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? 'Save Changes' : 'Add Component'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
