'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { EMPLOYMENT_TYPE, ROLES, philippineMobileSchema, type EmploymentType } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '@/stores/auth.store';
import { useBranch } from '@/hooks/use-branch';
import { useBranches } from '@/hooks/queries/use-branches';
import { useCreateEmployee } from '@/hooks/queries/use-employees';

const phoneField = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  philippineMobileSchema.optional(),
);

const formSchema = z.object({
  first_name: z.string().min(2, 'Minimum 2 characters').max(50),
  last_name: z.string().min(2, 'Minimum 2 characters').max(50),
  phone: phoneField,
  position: z.string().min(2, 'Minimum 2 characters').max(100),
  notes: z.string().max(1000).optional(),
  employment_type: z.enum([EMPLOYMENT_TYPE.REGULAR, EMPLOYMENT_TYPE.CONTRACTUAL, EMPLOYMENT_TYPE.PART_TIME]),
  branch_id: z.string().min(1, 'Select a branch'),
});

type FormValues = z.input<typeof formSchema>;

// Module-level constant so the Zustand selector below returns a stable
// reference when branchIds is undefined — inlining `?? []` would create a
// new array every render, which useSyncExternalStore treats as a changed
// snapshot and loops forever ("Maximum update depth exceeded").
const EMPTY_BRANCH_IDS: string[] = [];

interface SupervisorCreateEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Branch Employee Authorization: Employees (`staff`) have no login
 * credentials — no email or password fields here. Branch defaults to the
 * caller's currently selected branch (useBranch's activeBranchId for a
 * Supervisor; a Branch Account's own single branch_ids[0]) per the locked
 * Create Employee spec.
 */
export function SupervisorCreateEmployeeDialog({ open, onOpenChange }: SupervisorCreateEmployeeDialogProps) {
  const createEmployee = useCreateEmployee();
  const user = useAuthStore((state) => state.user);
  const callerBranchIds = user?.branchIds ?? EMPTY_BRANCH_IDS;
  const { activeBranchId } = useBranch();
  const isBranchAccount = user?.role === ROLES.BRANCH;
  const defaultBranchId = isBranchAccount ? (callerBranchIds[0] ?? '') : (activeBranchId ?? callerBranchIds[0] ?? '');

  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const branches = (branchData?.branches ?? []).filter((branch) => callerBranchIds.includes(branch.id));

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      first_name: '',
      last_name: '',
      phone: '',
      position: '',
      notes: '',
      employment_type: EMPLOYMENT_TYPE.REGULAR,
      branch_id: defaultBranchId,
    },
  });

  useEffect(() => {
    if (open) form.setValue('branch_id', defaultBranchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultBranchId]);

  function handleOpenChange(next: boolean) {
    if (!next) form.reset();
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createEmployee.mutateAsync({
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      phone: parsed.phone,
      role: ROLES.STAFF,
      employment_type: parsed.employment_type,
      branch_ids: [parsed.branch_id],
      position: parsed.position,
      notes: parsed.notes || undefined,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Employee</DialogTitle>
          <DialogDescription>Employees have no login of their own — they operate inside this branch&apos;s session.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="first_name" label="First Name" required>
                <Input placeholder="Juan" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="last_name" label="Last Name" required>
                <Input placeholder="Dela Cruz" />
              </FormFieldWrapper>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Role</Label>
                <Input value="Staff" disabled readOnly />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Input value="Active" disabled readOnly />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="position" label="Position" required>
                <Input placeholder="Cashier" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="phone" label="Contact Number" description="Optional — +63XXXXXXXXXX format">
                <Input placeholder="+639171234567" />
              </FormFieldWrapper>
            </div>

            <FormField
              control={form.control}
              name="employment_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Employment Type<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(Object.values(EMPLOYMENT_TYPE) as EmploymentType[]).map((type) => (
                        <SelectItem key={type} value={type}>
                          {type.replace('_', ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
              <Textarea placeholder="Internal notes about this employee" />
            </FormFieldWrapper>

            {isBranchAccount ? (
              <div className="space-y-2">
                <Label>Branch</Label>
                <Input value={branches.find((branch) => branch.id === defaultBranchId)?.name ?? ''} disabled readOnly />
              </div>
            ) : (
              <FormField
                control={form.control}
                name="branch_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Branch<span className="ml-0.5 text-destructive">*</span>
                    </FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={branchesLoading}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a branch" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {branches.map((branch) => (
                          <SelectItem key={branch.id} value={branch.id}>
                            {branch.name} ({branch.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createEmployee.isPending}>
                {createEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Employee
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
