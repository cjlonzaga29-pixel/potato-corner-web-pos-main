'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useCreateProductOption } from '@/hooks/queries/use-product-options';
import { useInventoryCategories, useInventoryItems, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { useOptionDeductionState } from './use-option-deduction-state';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z.object({
  code: z
    .string()
    .min(2, 'Minimum 2 characters')
    .max(50)
    .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, 'Lowercase letters, numbers, - or _ only'),
  name: z.string().min(1, 'Required').max(100),
  price_adjustment: z.coerce.number(),
  sort_order: optionalCoercedNumber(0),
  is_active: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { code: '', name: '', price_adjustment: 0, sort_order: '', is_active: true };

interface CreateOptionDialogProps {
  groupId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOptionDialog({ groupId, open, onOpenChange }: CreateOptionDialogProps) {
  const createOption = useCreateProductOption(groupId);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  const { data: categories } = useInventoryCategories();
  const { data: inventoryItems } = useInventoryItems();
  const { data: units } = useUnitsOfMeasure();
  const deduction = useOptionDeductionState({ open, option: null, inventoryItems, units });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    const inventoryDeduction = deduction.toPayload();
    await createOption.mutateAsync({
      code: parsed.code,
      name: parsed.name,
      price_adjustment: parsed.price_adjustment,
      sort_order: parsed.sort_order,
      is_active: parsed.is_active,
      ...(inventoryDeduction ? { inventory_deduction: inventoryDeduction } : {}),
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Option</DialogTitle>
          <DialogDescription>e.g. Cheese, BBQ, Sour Cream — a selectable value within this group.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="code" label="Code" required description="Unique within this group">
              <Input placeholder="cheese" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="name" label="Name" required>
              <Input placeholder="Cheese" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="price_adjustment" label="Price Adjustment" description="Added to the base price when selected">
              <Input inputMode="decimal" placeholder="0" />
            </FormFieldWrapper>

            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">Inventory Deduction</p>

              <div className="space-y-2">
                <Label htmlFor="create-option-deduction-category">Inventory Category</Label>
                <Select value={deduction.categoryId} onValueChange={deduction.setCategoryId}>
                  <SelectTrigger id="create-option-deduction-category">
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
                <Label htmlFor="create-option-deduction-item">Inventory Item</Label>
                <Select value={deduction.inventoryItemId} onValueChange={deduction.setInventoryItemId} disabled={!deduction.categoryId}>
                  <SelectTrigger id="create-option-deduction-item">
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
                  <Label htmlFor="create-option-deduction-quantity">Quantity Required</Label>
                  <Input
                    id="create-option-deduction-quantity"
                    type="number"
                    min="0"
                    step="0.0001"
                    value={deduction.quantityRequired}
                    onChange={(event) => deduction.setQuantityRequired(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-option-deduction-unit">Deduction Unit</Label>
                <Select
                  value={deduction.deductionUnitId}
                  onValueChange={deduction.setDeductionUnitId}
                  disabled={!deduction.selectedItem || deduction.compatibleDeductionUnits.length === 0}
                >
                  <SelectTrigger id="create-option-deduction-unit">
                    <SelectValue placeholder="Select a unit" />
                  </SelectTrigger>
                  <SelectContent>
                    {deduction.compatibleDeductionUnits.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.code} — {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <FormFieldWrapper<FormValues> name="sort_order" label="Sort Order">
              <Input inputMode="numeric" placeholder="0" />
            </FormFieldWrapper>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.watch('is_active')} onCheckedChange={(checked) => form.setValue('is_active', checked)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createOption.isPending}>
                {createOption.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Option
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
