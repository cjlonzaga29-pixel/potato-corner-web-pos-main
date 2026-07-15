'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useCreateBranch } from '@/hooks/queries/use-branches';

/** Empty string -> undefined (skips validation for optional GPS fields) before coercing to a number. */
function optionalCoercedNumber(min: number, max: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().min(min).max(max).optional(),
  );
}

const formSchema = z.object({
  name: z.string().min(2, 'Minimum 2 characters').max(100),
  city: z.string().min(2, 'Minimum 2 characters'),
  address: z.string().min(5, 'Minimum 5 characters'),
  gpsLatitude: optionalCoercedNumber(-90, 90),
  gpsLongitude: optionalCoercedNumber(-180, 180),
  gpsRadiusMeters: z.coerce.number().int().min(10).max(1000).default(100),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  city: '',
  address: '',
  gpsLatitude: '',
  gpsLongitude: '',
  gpsRadiusMeters: 100,
};

interface CreateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Mirrors branches.repository.ts's generateBranchCode prefix logic — the number itself is only known once Redis INCR runs server-side on save. */
function previewCityPrefix(city: string): string {
  return city
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
}

export function CreateBranchDialog({ open, onOpenChange }: CreateBranchDialogProps) {
  const createBranch = useCreateBranch();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const city = form.watch('city');
  const prefix = previewCityPrefix(city ?? '');

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createBranch.mutateAsync({
      name: parsed.name,
      city: parsed.city,
      address: parsed.address,
      gpsLatitude: parsed.gpsLatitude,
      gpsLongitude: parsed.gpsLongitude,
      gpsRadiusMeters: parsed.gpsRadiusMeters,
      status: 'active',
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Branch</DialogTitle>
          <DialogDescription>The branch code is generated automatically from the city.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Branch Name" required>
              <Input placeholder="Main Branch" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="city" label="City" required description={city ? `Code preview: PC-${prefix || '___'}-XXX` : undefined}>
              <Input placeholder="Manila" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="address" label="Address" required>
              <Input placeholder="123 Rizal Street" />
            </FormFieldWrapper>

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="gpsLatitude" label="GPS Latitude" description="Optional">
                <Input placeholder="14.5995" inputMode="decimal" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="gpsLongitude" label="GPS Longitude" description="Optional">
                <Input placeholder="120.9842" inputMode="decimal" />
              </FormFieldWrapper>
            </div>

            <FormFieldWrapper<FormValues> name="gpsRadiusMeters" label="GPS Radius (meters)" description="Default 100m">
              <Input inputMode="numeric" />
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createBranch.isPending}>
                {createBranch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Branch
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
