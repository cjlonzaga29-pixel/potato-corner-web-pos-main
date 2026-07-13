'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { FlavorResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { FlavorColorSwatch } from './flavor-color-swatch';
import { useUpdateFlavor } from '@/hooks/queries/use-flavors';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z.object({
  name: z.string().min(2, 'Minimum 2 characters').max(50),
  description: z.string().max(255).optional(),
  color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a #RRGGBB color'),
  display_order: optionalCoercedNumber(0),
  is_active: z.boolean(),
});

type FormValues = z.input<typeof formSchema>;

function valuesFromFlavor(flavor: FlavorResponse): FormValues {
  return {
    name: flavor.name,
    description: flavor.description ?? '',
    color_hex: flavor.color_hex ?? '#FFD700',
    display_order: flavor.display_order ?? '',
    is_active: flavor.is_active,
  };
}

interface EditFlavorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flavor: FlavorResponse;
}

export function EditFlavorDialog({ open, onOpenChange, flavor }: EditFlavorDialogProps) {
  const updateFlavor = useUpdateFlavor(flavor.id);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: valuesFromFlavor(flavor) });
  const colorHex = form.watch('color_hex');

  useEffect(() => {
    if (open) form.reset(valuesFromFlavor(flavor));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the dialog opens or the target flavor changes
  }, [open, flavor]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await updateFlavor.mutateAsync({
      name: parsed.name,
      description: parsed.description || undefined,
      color_hex: parsed.color_hex,
      display_order: parsed.display_order,
      is_active: parsed.is_active,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Flavor</DialogTitle>
          <DialogDescription>Changes apply everywhere this flavor is linked.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Flavor Name" required>
              <Input placeholder="Sour Cream" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={2} />
            </FormFieldWrapper>

            <div className="flex items-end gap-3">
              <div className="flex-1">
                <FormFieldWrapper<FormValues> name="color_hex" label="Color" required description="#RRGGBB">
                  <Input placeholder="#FFD700" />
                </FormFieldWrapper>
              </div>
              <FlavorColorSwatch colorHex={/^#[0-9A-Fa-f]{6}$/.test(colorHex ?? '') ? (colorHex ?? null) : null} className="mb-2 h-8 w-8" />
            </div>

            <FormFieldWrapper<FormValues> name="display_order" label="Display Order">
              <Input inputMode="numeric" placeholder="0" />
            </FormFieldWrapper>

            <div className="flex items-center justify-between rounded-md border p-3">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.watch('is_active')} onCheckedChange={(checked) => form.setValue('is_active', checked)} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateFlavor.isPending}>
                {updateFlavor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
