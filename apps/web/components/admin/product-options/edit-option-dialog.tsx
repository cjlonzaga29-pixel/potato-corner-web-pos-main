'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { ProductOptionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useUpdateProductOption, useProductOptionAssignedVariants } from '@/hooks/queries/use-product-options';
import { useInventoryCategories, useInventoryItems, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { VariantDeductionCard, type VariantDeductionCardHandle } from './variant-deduction-card';

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

  const cardRefs = useRef(new Map<string, VariantDeductionCardHandle>());
  const [isSavingDeductions, setIsSavingDeductions] = useState(false);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function saveDeductions() {
    if (!assignedVariants || !optionId) return;
    setIsSavingDeductions(true);
    try {
      for (const variant of assignedVariants) {
        await cardRefs.current.get(variant.product_variant_id)?.save();
      }
    } finally {
      setIsSavingDeductions(false);
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
    await saveDeductions();
    handleOpenChange(false);
  }

  const isSaving = updateOption.isPending || isSavingDeductions;

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
                <div className={assignedVariants.length > 1 ? 'space-y-3' : ''}>
                  {assignedVariants.map((variant) => (
                    <VariantDeductionCard
                      key={variant.product_variant_id}
                      ref={(node) => {
                        if (node) cardRefs.current.set(variant.product_variant_id, node);
                        else cardRefs.current.delete(variant.product_variant_id);
                      }}
                      variantId={variant.product_variant_id}
                      variantLabel={`${variant.product_name} ${variant.variant_name}`}
                      optionId={optionId}
                      open={open}
                      showHeader={assignedVariants.length > 1}
                      categories={categories}
                      inventoryItems={inventoryItems}
                      units={units}
                    />
                  ))}
                </div>
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
