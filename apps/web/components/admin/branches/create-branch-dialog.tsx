'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ROLES, EMPLOYMENT_TYPE } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useCreateBranch } from '@/hooks/queries/use-branches';
import { useCreateEmployee } from '@/hooks/queries/use-employees';

/** Empty string -> undefined (skips validation for optional GPS fields) before coercing to a number. */
function optionalCoercedNumber(min: number, max: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().min(min).max(max).optional(),
  );
}

const formSchema = z
  .object({
    name: z.string().min(2, 'Minimum 2 characters').max(100),
    city: z.string().min(2, 'Minimum 2 characters'),
    address: z.string().min(5, 'Minimum 5 characters'),
    gpsLatitude: optionalCoercedNumber(-90, 90),
    gpsLongitude: optionalCoercedNumber(-180, 180),
    gpsRadiusMeters: z.coerce.number().int().min(10).max(1000).default(100),
    accountFirstName: z.string().min(2, 'Minimum 2 characters').max(50),
    accountLastName: z.string().min(2, 'Minimum 2 characters').max(50),
    username: z.email('Must be a valid email'),
    password: z.string().min(8, 'Minimum 8 characters'),
    confirmPassword: z.string().min(8, 'Minimum 8 characters'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  city: '',
  address: '',
  gpsLatitude: '',
  gpsLongitude: '',
  gpsRadiusMeters: 100,
  accountFirstName: '',
  accountLastName: '',
  username: '',
  password: '',
  confirmPassword: '',
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
  const createAccount = useCreateEmployee();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const city = form.watch('city');
  const prefix = previewCityPrefix(city ?? '');
  const isPending = createBranch.isPending || createAccount.isPending;

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    const branch = await createBranch.mutateAsync({
      name: parsed.name,
      city: parsed.city,
      address: parsed.address,
      gpsLatitude: parsed.gpsLatitude,
      gpsLongitude: parsed.gpsLongitude,
      gpsRadiusMeters: parsed.gpsRadiusMeters,
      status: 'active',
    });

    // Branch Employee Authorization: this mints the Branch Account itself
    // (role `branch`) — the login that authenticates the physical branch.
    // Employees (`staff`) never get their own credentials; they're
    // authorized inside this session (see /branch/select-employee).
    // Regional oversight (`supervisor`) is a separate role assigned to an
    // existing user via assign-supervisor-dialog.tsx, not created here.
    await createAccount.mutateAsync({
      email: parsed.username,
      first_name: parsed.accountFirstName,
      last_name: parsed.accountLastName,
      role: ROLES.BRANCH,
      employment_type: EMPLOYMENT_TYPE.REGULAR,
      branch_ids: [branch.id],
      initial_password: parsed.password,
    });

    toast.success('Branch created, branch account created, login credentials set');
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

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="accountFirstName" label="Account First Name" required>
                <Input placeholder="Juan" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="accountLastName" label="Account Last Name" required>
                <Input placeholder="Dela Cruz" />
              </FormFieldWrapper>
            </div>

            <FormFieldWrapper<FormValues> name="username" label="Username" description="Used as the branch account login (email format)" required>
              <Input type="email" placeholder="branch.manila@potatocorner.com" />
            </FormFieldWrapper>

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="password" label="Password" required>
                <Input type="password" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="confirmPassword" label="Confirm Password" required>
                <Input type="password" />
              </FormFieldWrapper>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Branch
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
