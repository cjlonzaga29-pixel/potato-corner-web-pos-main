'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { UnitOfMeasureResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useUpdateUnitOfMeasure } from '@/hooks/queries/use-universal-inventory';

const formSchema = z.object({
  name: z.string().min(1, 'Required'),
  is_active: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

interface EditUnitDialogProps {
  unit: UnitOfMeasureResponse | null;
  onOpenChange: (open: boolean) => void;
}

export function EditUnitDialog({ unit, onOpenChange }: EditUnitDialogProps) {
  const updateUnit = useUpdateUnitOfMeasure(unit?.id ?? '');
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: unit?.name ?? '', is_active: unit?.is_active ?? true },
  });

  useEffect(() => {
    if (unit) form.reset({ name: unit.name, is_active: unit.is_active });
  }, [unit, form]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    await updateUnit.mutateAsync(values);
    handleOpenChange(false);
  }

  return (
    <Dialog open={!!unit} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Unit of Measure</DialogTitle>
          <DialogDescription>Code, dimension, and base unit are fixed after creation and cannot be changed here.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Code</p>
              <Input value={unit?.code ?? ''} disabled />
              <p className="text-sm text-muted-foreground">Fixed at creation</p>
            </div>

            <FormFieldWrapper<FormValues> name="name" label="Name" required>
              <Input placeholder="Kilogram" />
            </FormFieldWrapper>

            <div className="space-y-2">
              <p className="text-sm font-medium">Dimension</p>
              <Input value={unit?.dimension ?? ''} disabled />
              <p className="text-sm text-muted-foreground">Fixed at creation</p>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Base Unit</p>
              <Switch checked={unit?.is_base_unit ?? false} disabled />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.watch('is_active')} onCheckedChange={(checked) => form.setValue('is_active', checked)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateUnit.isPending}>
                {updateUnit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
