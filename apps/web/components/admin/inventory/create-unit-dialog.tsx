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
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useCreateUnitOfMeasure } from '@/hooks/queries/use-universal-inventory';

const formSchema = z.object({
  code: z.string().min(1, 'Required'),
  name: z.string().min(1, 'Required'),
  dimension: z.enum(['WEIGHT', 'VOLUME', 'COUNT']),
  is_base_unit: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = { code: '', name: '', dimension: 'WEIGHT', is_base_unit: false };

interface CreateUnitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateUnitDialog({ open, onOpenChange }: CreateUnitDialogProps) {
  const createUnit = useCreateUnitOfMeasure();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    await createUnit.mutateAsync(values);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Unit of Measure</DialogTitle>
          <DialogDescription>Dimension-only classification — conversions are managed separately.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="code" label="Code" required description="e.g. kg, g, L, pc">
              <Input placeholder="kg" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="name" label="Name" required>
              <Input placeholder="Kilogram" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="dimension" label="Dimension" required>
              <Select value={form.watch('dimension')} onValueChange={(value) => form.setValue('dimension', value as FormValues['dimension'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WEIGHT">Weight</SelectItem>
                  <SelectItem value="VOLUME">Volume</SelectItem>
                  <SelectItem value="COUNT">Count</SelectItem>
                </SelectContent>
              </Select>
            </FormFieldWrapper>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Base Unit</p>
              <Switch checked={form.watch('is_base_unit')} onCheckedChange={(checked) => form.setValue('is_base_unit', checked)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createUnit.isPending}>
                {createUnit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Unit
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
