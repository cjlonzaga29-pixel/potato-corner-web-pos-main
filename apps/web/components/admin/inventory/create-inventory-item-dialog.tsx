'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useCreateInventoryItem, useInventoryCategories, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';

const formSchema = z.object({
  name: z.string().min(1, 'Required'),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  category_id: z.string().optional(),
  base_unit_id: z.uuid('Select a base unit'),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { name: '', sku: '', barcode: '', category_id: '', base_unit_id: '' };

interface CreateInventoryItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateInventoryItemDialog({ open, onOpenChange }: CreateInventoryItemDialogProps) {
  const createItem = useCreateInventoryItem();
  const { data: categories } = useInventoryCategories();
  const { data: units } = useUnitsOfMeasure();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    await createItem.mutateAsync({
      name: values.name,
      sku: values.sku || undefined,
      barcode: values.barcode || undefined,
      category_id: values.category_id || undefined,
      base_unit_id: values.base_unit_id,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Universal Inventory Item</DialogTitle>
          <DialogDescription>One inventory identity, shared company-wide — branches reference it, never duplicate it.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Item Name" required>
              <Input placeholder="Cheese Powder" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="sku" label="SKU">
              <Input placeholder="Optional" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="barcode" label="Barcode">
              <Input placeholder="Optional" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="category_id" label="Category">
              <Select value={form.watch('category_id')} onValueChange={(value) => form.setValue('category_id', value)}>
                <SelectTrigger>
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
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="base_unit_id" label="Base Unit" required>
              <Select value={form.watch('base_unit_id')} onValueChange={(value) => form.setValue('base_unit_id', value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a base unit" />
                </SelectTrigger>
                <SelectContent>
                  {(units ?? []).map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.code} — {unit.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createItem.isPending}>
                {createItem.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Item
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
