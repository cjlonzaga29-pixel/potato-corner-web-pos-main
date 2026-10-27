'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { EMPLOYMENT_TYPE, ROLES, philippineMobileSchema, strongPasswordSchema, type EmploymentType } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import { useCreateSupervisor } from '@/hooks/queries/use-employees';

const phoneField = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  philippineMobileSchema.optional(),
);

const formSchema = z.object({
  first_name: z.string().min(2, 'Minimum 2 characters').max(50),
  last_name: z.string().min(2, 'Minimum 2 characters').max(50),
  email: z.email('A valid email is required'),
  initial_password: strongPasswordSchema,
  phone: phoneField,
  employment_type: z.enum([EMPLOYMENT_TYPE.REGULAR, EMPLOYMENT_TYPE.CONTRACTUAL, EMPLOYMENT_TYPE.PART_TIME]),
  notes: z.string().max(1000).optional(),
  branch_ids: z.array(z.string()).min(1, 'Select at least one branch'),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  first_name: '',
  last_name: '',
  email: '',
  initial_password: '',
  phone: '',
  employment_type: EMPLOYMENT_TYPE.REGULAR,
  notes: '',
  branch_ids: [],
};

interface AddSupervisorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * POS-PERF-P40 — Admin "Add Supervisor". Creates supervisor accounts only:
 * there is no role selector, and the endpoint it calls
 * (POST /api/employees/supervisors) rejects any other role server-side.
 * Staff are created in the Supervisor console within assigned branches.
 * User, role and every branch assignment are written in one backend call.
 */
export function AddSupervisorDialog({ open, onOpenChange }: AddSupervisorDialogProps) {
  const createSupervisor = useCreateSupervisor();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const branches = branchData?.branches ?? [];

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const branchIds = form.watch('branch_ids');

  useEffect(() => {
    if (open) form.reset(DEFAULT_VALUES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggleBranch(branchId: string, checked: boolean) {
    const next = checked ? [...branchIds, branchId] : branchIds.filter((id) => id !== branchId);
    form.setValue('branch_ids', next, { shouldValidate: true });
  }

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createSupervisor.mutateAsync({
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      email: parsed.email,
      initial_password: parsed.initial_password,
      phone: parsed.phone,
      role: ROLES.SUPERVISOR,
      employment_type: parsed.employment_type,
      branch_ids: parsed.branch_ids,
      notes: parsed.notes || undefined,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Supervisor</DialogTitle>
          <DialogDescription>Create a supervisor login and choose the branches they manage.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldWrapper<FormValues> name="first_name" label="First Name" required>
                <Input placeholder="Juan" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="last_name" label="Last Name" required>
                <Input placeholder="Dela Cruz" />
              </FormFieldWrapper>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormFieldWrapper<FormValues> name="email" label="Email" required>
                <Input type="email" autoComplete="off" placeholder="juan@example.com" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="initial_password" label="Password" required>
                <Input type="password" autoComplete="new-password" placeholder="••••••••" />
              </FormFieldWrapper>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <FormFieldWrapper<FormValues> name="phone" label="Contact Number" description="Optional">
                <Input placeholder="+639171234567" />
              </FormFieldWrapper>
            </div>

            <FormField
              control={form.control}
              name="branch_ids"
              render={() => (
                <FormItem>
                  <FormLabel>
                    Assigned Branches<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <FormDescription>Select one or more active branches this supervisor can access.</FormDescription>
                  {branchesLoading ? (
                    <p className="text-sm text-muted-foreground">Loading branches...</p>
                  ) : branches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active branches available.</p>
                  ) : (
                    <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                      {branches.map((branch) => (
                        <label key={branch.id} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={branchIds.includes(branch.id)} onCheckedChange={(checked) => toggleBranch(branch.id, checked === true)} />
                          {branch.name} ({branch.code})
                        </label>
                      ))}
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
              <Textarea placeholder="Internal notes about this supervisor" />
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSupervisor.isPending}>
                {createSupervisor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Supervisor
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
