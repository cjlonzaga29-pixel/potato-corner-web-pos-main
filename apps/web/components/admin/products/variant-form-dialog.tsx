'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/shared/forms/currency-input';
import { useCreateVariant, useUpdateVariant } from '@/hooks/queries/use-products';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z.object({
  name: z.string().min(1, 'Required').max(50),
  size_label: z.string().min(1, 'Required').max(30),
  base_price: z.coerce.number().positive('Must be greater than 0'),
  display_order: optionalCoercedNumber(0),
  is_active: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

function defaultValues(variant?: ProductVariantResponse): FormValues {
  return {
    name: variant?.name ?? '',
    size_label: variant?.size_label ?? '',
    base_price: variant?.base_price ?? 0,
    display_order: variant?.display_order ?? '',
    is_active: variant?.is_active ?? true,
  };
}

interface VariantFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variant?: ProductVariantResponse;
}

export function VariantFormDialog({ open, onOpenChange, productId, variant }: VariantFormDialogProps) {
  const isEdit = Boolean(variant);
  const createVariant = useCreateVariant(productId);
  const updateVariant = useUpdateVariant(productId, variant?.id ?? '');
  const mutation = isEdit ? updateVariant : createVariant;

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaultValues(variant) });

  useEffect(() => {
    if (open) form.reset(defaultValues(variant));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the dialog opens or the target variant changes
  }, [open, variant]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await mutation.mutateAsync({
      name: parsed.name,
      size_label: parsed.size_label,
      base_price: parsed.base_price,
      display_order: parsed.display_order,
      is_active: parsed.is_active,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Variant' : 'Add Variant'}</DialogTitle>
          <DialogDescription>{isEdit ? 'Update this variant.' : 'Add a new size/variant to this product.'}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Variant Name" required>
              <Input placeholder="Regular" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="size_label" label="Size Label" required>
              <Input placeholder="Regular" />
            </FormFieldWrapper>

            {/* CurrencyInput's onChange(value: number) doesn't match the (event) signature FormFieldWrapper clones onto children — wired directly via Controller instead. */}
            <FormField
              control={form.control}
              name="base_price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Base Price<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <CurrencyInput value={typeof field.value === 'number' ? field.value : Number(field.value)} onChange={field.onChange} onBlur={field.onBlur} name="base_price" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormFieldWrapper<FormValues> name="display_order" label="Display Order">
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
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEdit ? 'Save Changes' : 'Add Variant'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
