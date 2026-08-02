'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { InventoryCategoryResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useUpdateInventoryCategory } from '@/hooks/queries/use-universal-inventory';

const formSchema = z.object({
  name: z.string().min(1, 'Required'),
  code: z.string().optional(),
  description: z.string().optional(),
  is_active: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

interface EditCategoryDialogProps {
  category: InventoryCategoryResponse | null;
  onOpenChange: (open: boolean) => void;
}

export function EditCategoryDialog({ category, onOpenChange }: EditCategoryDialogProps) {
  const updateCategory = useUpdateInventoryCategory(category?.id ?? '');
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', code: '', description: '', is_active: true },
  });

  useEffect(() => {
    if (category) {
      form.reset({
        name: category.name,
        code: category.code ?? '',
        description: category.description ?? '',
        is_active: category.is_active,
      });
    }
  }, [category, form]);

  async function onSubmit(values: FormValues) {
    await updateCategory.mutateAsync({
      name: values.name,
      code: values.code || undefined,
      description: values.description || undefined,
      is_active: values.is_active,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={Boolean(category)} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Inventory Category</DialogTitle>
          <DialogDescription>Operator-configurable grouping for Universal Inventory items.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Category Name" required>
              <Input placeholder="Raw Ingredients" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="code" label="Code">
              <Input placeholder="RAW" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={2} />
            </FormFieldWrapper>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.watch('is_active')} onCheckedChange={(checked) => form.setValue('is_active', checked)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateCategory.isPending}>
                {updateCategory.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
