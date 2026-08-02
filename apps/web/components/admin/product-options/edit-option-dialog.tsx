'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { ProductOptionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useUpdateProductOption, useProductOptionAssignedVariants } from '@/hooks/queries/use-product-options';
import { useInventoryCategories, useInventoryItems, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { useProductComponents, useCreateProductComponent, useUpdateProductComponent, useDeleteProductComponent } from '@/hooks/queries/use-product-components';
import { useOptionDeductionState } from './use-option-deduction-state';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z.object({
  name: z.string().min(1, 'Required').max(100),
  price_adjustment: z.coerce.number(),
  sort_order: optionalCoercedNumber(0),
  is_active: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

function valuesFromOption(option: ProductOptionResponse): FormValues {
  return {
    name: option.name,
    price_adjustment: option.price_adjustment,
    sort_order: option.sort_order ?? '',
    is_active: option.is_active,
  };
}

interface EditOptionDialogProps {
  groupId: string;
  option: ProductOptionResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditOptionDialog({ groupId, option, open, onOpenChange }: EditOptionDialogProps) {
  const optionId = option?.id ?? '';
  const updateOption = useUpdateProductOption(groupId, optionId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: option ? valuesFromOption(option) : undefined });

  useEffect(() => {
    if (option) form.reset(valuesFromOption(option));
  }, [option, form]);

  const { data: assignedVariants, isLoading: variantsLoading } = useProductOptionAssignedVariants(groupId, optionId);
  const { data: categories } = useInventoryCategories();
  const { data: inventoryItems } = useInventoryItems();
  const { data: units } = useUnitsOfMeasure();

  const deduction = useOptionDeductionState({ open, optionId, assignedVariants, inventoryItems, units });

  const { data: components } = useProductComponents(deduction.selectedVariantId);
  const existingComponent = components?.find((component) => component.product_option_id === optionId);

  useEffect(() => {
    deduction.hydrateFromExistingComponent(existingComponent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingComponent?.id, existingComponent?.quantity_required, existingComponent?.inventory_item_id, deduction.selectedVariantId]);

  const createComponent = useCreateProductComponent(deduction.selectedVariantId ?? '');
  const updateComponent = useUpdateProductComponent(deduction.selectedVariantId ?? '', existingComponent?.id ?? '');
  const deleteComponent = useDeleteProductComponent(deduction.selectedVariantId ?? '');

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function saveDeduction() {
    if (!deduction.selectedVariantId || !optionId) return;

    const hasDeductionInput = Boolean(deduction.inventoryItemId) && deduction.quantityRequired !== '' && Number(deduction.quantityRequired) > 0;

    if (!hasDeductionInput) {
      if (existingComponent) await deleteComponent.mutateAsync(existingComponent.id);
      return;
    }

    if (!deduction.baseUnit) return;

    if (existingComponent && existingComponent.inventory_item_id === deduction.inventoryItemId) {
      await updateComponent.mutateAsync({
        quantity_required: Number(deduction.quantityRequired),
        recipe_unit_id: deduction.baseUnit.id,
      });
    } else {
      if (existingComponent) await deleteComponent.mutateAsync(existingComponent.id);
      await createComponent.mutateAsync({
        product_variant_id: deduction.selectedVariantId,
        inventory_item_id: deduction.inventoryItemId,
        quantity_required: Number(deduction.quantityRequired),
        recipe_unit_id: deduction.baseUnit.id,
        product_option_id: optionId,
      });
    }
  }

  async function onSubmit(values: FormValues) {
    if (!option) return;
    const parsed = formSchema.parse(values);
    await updateOption.mutateAsync({
      name: parsed.name,
      price_adjustment: parsed.price_adjustment,
      sort_order: parsed.sort_order,
      is_active: parsed.is_active,
    });
    await saveDeduction();
    handleOpenChange(false);
  }

  const isSaving =
    updateOption.isPending || createComponent.isPending || updateComponent.isPending || deleteComponent.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Option</DialogTitle>
          <DialogDescription>Update this selectable option&apos;s details.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium leading-none">Code</p>
              <Input value={option?.code ?? ''} disabled />
              <p className="text-[0.8rem] text-muted-foreground">Code is a stable identifier and cannot be changed</p>
            </div>

            <FormFieldWrapper<FormValues> name="name" label="Name" required>
              <Input placeholder="Cheese" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="price_adjustment" label="Price Adjustment" description="Added to the base price when selected">
              <Input inputMode="decimal" placeholder="0" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="sort_order" label="Sort Order">
              <Input inputMode="numeric" placeholder="0" />
            </FormFieldWrapper>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.watch('is_active')} onCheckedChange={(checked) => form.setValue('is_active', checked)} />
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">Inventory Deduction</p>

              {variantsLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !assignedVariants || assignedVariants.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Assign this option&apos;s group to a variant before configuring a deduction.
                </p>
              ) : (
                <>
                  {assignedVariants.length > 1 && (
                    <div className="space-y-2">
                      <Label htmlFor="deduction-variant">Variant</Label>
                      <Select value={deduction.selectedVariantId ?? ''} onValueChange={deduction.setSelectedVariantId}>
                        <SelectTrigger id="deduction-variant">
                          <SelectValue placeholder="Select a variant" />
                        </SelectTrigger>
                        <SelectContent>
                          {assignedVariants.map((variant) => (
                            <SelectItem key={variant.product_variant_id} value={variant.product_variant_id}>
                              {variant.product_name} {variant.variant_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="deduction-category">Inventory Category</Label>
                    <Select value={deduction.categoryId} onValueChange={deduction.setCategoryId}>
                      <SelectTrigger id="deduction-category">
                        <SelectValue placeholder="Select a category" />
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
                    <Label htmlFor="deduction-item">Inventory Item</Label>
                    <Select value={deduction.inventoryItemId} onValueChange={deduction.setInventoryItemId} disabled={!deduction.categoryId}>
                      <SelectTrigger id="deduction-item">
                        <SelectValue placeholder={deduction.categoryId ? 'Select an item' : 'Select a category first'} />
                      </SelectTrigger>
                      <SelectContent>
                        {deduction.itemsInCategory.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Base Unit</Label>
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                        {deduction.baseUnit ? `${deduction.baseUnit.code} — ${deduction.baseUnit.name}` : '—'}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="deduction-quantity">Quantity Required</Label>
                      <Input
                        id="deduction-quantity"
                        type="number"
                        min="0"
                        step="0.0001"
                        value={deduction.quantityRequired}
                        onChange={(event) => deduction.setQuantityRequired(event.target.value)}
                      />
                    </div>
                  </div>

                  {deduction.selectedItem && deduction.quantityRequired !== '' && (
                    <div className="rounded-md border bg-muted/30 p-3 text-sm">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Deduction Preview</p>
                      <p className="mt-2 font-medium">{deduction.selectedItem.name}</p>
                      <p className="text-base font-semibold">
                        {deduction.quantityRequired} {deduction.baseUnit?.code ?? ''}
                      </p>
                      {deduction.selectedItem.category_name && (
                        <p className="text-xs text-muted-foreground">from {deduction.selectedItem.category_name}</p>
                      )}
                      <p className="text-xs text-muted-foreground">per item sold</p>
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
