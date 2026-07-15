'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import type { BranchResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useUpdateBranch } from '@/hooks/queries/use-branches';

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
  gpsRadiusMeters: z.coerce.number().int().min(10).max(1000),
});

type FormValues = z.input<typeof formSchema>;

interface EditBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchResponse;
}

function toFormValues(branch: BranchResponse): FormValues {
  return {
    name: branch.name,
    city: branch.city,
    address: branch.address,
    gpsLatitude: branch.gpsLatitude ?? '',
    gpsLongitude: branch.gpsLongitude ?? '',
    gpsRadiusMeters: branch.gpsRadiusMeters,
  };
}

/** Code is deliberately not a form field — branch codes are immutable after creation (locked rule). */
export function EditBranchDialog({ open, onOpenChange, branch }: EditBranchDialogProps) {
  const updateBranch = useUpdateBranch(branch.id);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: toFormValues(branch) });

  useEffect(() => {
    if (open) form.reset(toFormValues(branch));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branch.id]);

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await updateBranch.mutateAsync(parsed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Branch</DialogTitle>
          <DialogDescription>The branch code cannot be changed after creation.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>Branch Code</Label>
          <Input value={branch.code} disabled readOnly />
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Branch Name" required>
              <Input placeholder="Main Branch" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="city" label="City" required>
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

            <FormFieldWrapper<FormValues> name="gpsRadiusMeters" label="GPS Radius (meters)">
              <Input inputMode="numeric" />
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateBranch.isPending}>
                {updateBranch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
