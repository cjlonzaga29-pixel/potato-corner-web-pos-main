'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useCreateProductOptionGroup } from '@/hooks/queries/use-product-options';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z
  .object({
    code: z
      .string()
      .min(2, 'Minimum 2 characters')
      .max(50)
      .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, 'Lowercase letters, numbers, - or _ only'),
    name: z.string().min(2, 'Minimum 2 characters').max(100),
    description: z.string().max(500).optional(),
    selection_type: z.enum(['SINGLE', 'MULTIPLE']),
    min_selections: z.coerce.number().int().min(0),
    max_selections: optionalCoercedNumber(1),
    required: z.boolean(),
    is_active: z.boolean(),
  })
  .refine((data) => data.selection_type !== 'SINGLE' || !data.max_selections || data.max_selections <= 1, {
    message: 'A SINGLE selection group cannot allow more than 1 selection',
    path: ['max_selections'],
  });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  code: '',
  name: '',
  description: '',
  selection_type: 'SINGLE',
  min_selections: 0,
  max_selections: '',
  required: false,
  is_active: true,
};

interface CreateOptionGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOptionGroupDialog({ open, onOpenChange }: CreateOptionGroupDialogProps) {
  const createGroup = useCreateProductOptionGroup();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createGroup.mutateAsync({
      code: parsed.code,
      name: parsed.name,
      description: parsed.description || undefined,
      selection_type: parsed.selection_type,
      min_selections: parsed.min_selections,
      max_selections: parsed.max_selections,
      required: parsed.required,
      is_active: parsed.is_active,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Option Group</DialogTitle>
          <DialogDescription>e.g. Flavor, Size, Add-ons — the generic selection rule shared by variants.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="code" label="Code" required description="Stable identifier, e.g. flavor">
              <Input placeholder="flavor" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="name" label="Name" required>
              <Input placeholder="Flavor" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={2} />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="selection_type" label="Selection Type" required>
              <Select value={form.watch('selection_type')} onValueChange={(value) => form.setValue('selection_type', value as 'SINGLE' | 'MULTIPLE')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SINGLE">Single (radio)</SelectItem>
                  <SelectItem value="MULTIPLE">Multiple (checkbox)</SelectItem>
                </SelectContent>
              </Select>
            </FormFieldWrapper>

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="min_selections" label="Min Selections" required>
                <Input inputMode="numeric" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="max_selections" label="Max Selections">
                <Input inputMode="numeric" placeholder="No limit" />
              </FormFieldWrapper>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Required</p>
              <Switch checked={form.watch('required')} onCheckedChange={(checked) => form.setValue('required', checked)} />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.watch('is_active')} onCheckedChange={(checked) => form.setValue('is_active', checked)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createGroup.isPending}>
                {createGroup.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Option Group
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
