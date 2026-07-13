'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { ProductResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useUpdateProduct } from '@/hooks/queries/use-products';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z
  .object({
    name: z.string().min(2, 'Minimum 2 characters').max(100),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
    display_order: optionalCoercedNumber(0),
    is_seasonal: z.boolean(),
    seasonal_start_date: z.string().optional(),
    seasonal_end_date: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.is_seasonal) return;
    if (!data.seasonal_start_date || !data.seasonal_end_date) {
      ctx.addIssue({ code: 'custom', path: ['seasonal_start_date'], message: 'Seasonal products require both a start and end date' });
      return;
    }
    if (data.seasonal_end_date < data.seasonal_start_date) {
      ctx.addIssue({ code: 'custom', path: ['seasonal_end_date'], message: 'End date must not be before the start date' });
    }
  });

type FormValues = z.input<typeof formSchema>;

function valuesFromProduct(product: ProductResponse): FormValues {
  return {
    name: product.name,
    description: product.description ?? '',
    category: product.category ?? '',
    display_order: product.display_order ?? '',
    is_seasonal: product.is_seasonal,
    seasonal_start_date: product.seasonal_start_date ?? '',
    seasonal_end_date: product.seasonal_end_date ?? '',
  };
}

interface EditProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductResponse;
}

export function EditProductDialog({ open, onOpenChange, product }: EditProductDialogProps) {
  const updateProduct = useUpdateProduct(product.id);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: valuesFromProduct(product) });
  const isSeasonal = form.watch('is_seasonal');

  useEffect(() => {
    if (open) form.reset(valuesFromProduct(product));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the dialog opens or the underlying product changes
  }, [open, product]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await updateProduct.mutateAsync({
      name: parsed.name,
      description: parsed.description || undefined,
      category: parsed.category || undefined,
      display_order: parsed.display_order,
      is_seasonal: parsed.is_seasonal,
      seasonal_start_date: parsed.is_seasonal ? parsed.seasonal_start_date : null,
      seasonal_end_date: parsed.is_seasonal ? parsed.seasonal_end_date : null,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>Status changes go through the Change Status action, not this form.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Product Name" required>
              <Input placeholder="Cheese Fries" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={3} />
            </FormFieldWrapper>

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="category" label="Category">
                <Input placeholder="Fries" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="display_order" label="Display Order">
                <Input inputMode="numeric" placeholder="0" />
              </FormFieldWrapper>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Seasonal Product</p>
                <p className="text-xs text-muted-foreground">Only available within a date range.</p>
              </div>
              <Switch checked={isSeasonal} onCheckedChange={(checked) => form.setValue('is_seasonal', checked)} />
            </div>

            {isSeasonal && (
              <div className="grid grid-cols-2 gap-3">
                <FormFieldWrapper<FormValues> name="seasonal_start_date" label="Start Date" required>
                  <Input type="date" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="seasonal_end_date" label="End Date" required>
                  <Input type="date" />
                </FormFieldWrapper>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateProduct.isPending}>
                {updateProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
