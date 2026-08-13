'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import {
  EMPLOYMENT_TYPE,
  ROLES,
  ROLE_LABELS,
  philippineMobileSchema,
  strongPasswordSchema,
  type EmploymentType,
} from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import { useCreateEmployee } from '@/hooks/queries/use-employees';

// Super Admin and Branch Account creation aren't offered here: Branch
// Accounts already have their own dedicated management flow, and creating
// another Super Admin from a generic form is a deliberately higher-friction
// action this dialog doesn't take on.
const CREATABLE_ROLES = [ROLES.SUPERVISOR, ROLES.STAFF] as const;
type CreatableRole = (typeof CREATABLE_ROLES)[number];

const phoneField = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  philippineMobileSchema.optional(),
);

const formSchema = z
  .object({
    first_name: z.string().min(2, 'Minimum 2 characters').max(50),
    last_name: z.string().min(2, 'Minimum 2 characters').max(50),
    email: z.string().optional(),
    initial_password: z.string().optional(),
    phone: phoneField,
    role: z.enum(CREATABLE_ROLES),
    employment_type: z.enum([EMPLOYMENT_TYPE.REGULAR, EMPLOYMENT_TYPE.CONTRACTUAL, EMPLOYMENT_TYPE.PART_TIME]),
    position: z.string().optional(),
    notes: z.string().max(1000).optional(),
    branch_ids: z.array(z.string()).min(1, 'Select at least one branch'),
  })
  .refine((data) => data.role !== ROLES.SUPERVISOR || z.email().safeParse(data.email).success, {
    message: 'A valid email is required for a Supervisor account',
    path: ['email'],
  })
  .refine((data) => data.role !== ROLES.SUPERVISOR || strongPasswordSchema.safeParse(data.initial_password).success, {
    message: 'Password needs 8+ characters, upper, lower, number, and a special character',
    path: ['initial_password'],
  })
  .refine((data) => data.role !== ROLES.STAFF || Boolean(data.position && data.position.length >= 2), {
    message: 'Position is required for a Staff employee',
    path: ['position'],
  })
  .refine((data) => data.role !== ROLES.STAFF || data.branch_ids.length === 1, {
    message: 'A Staff employee must be assigned to exactly one branch',
    path: ['branch_ids'],
  });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  first_name: '',
  last_name: '',
  email: '',
  initial_password: '',
  phone: '',
  role: ROLES.SUPERVISOR,
  employment_type: EMPLOYMENT_TYPE.REGULAR,
  position: '',
  notes: '',
  branch_ids: [],
};

interface AdminCreateEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Admin-only Add Employee flow. Posts to the same POST /api/employees the
 * Supervisor console's create-employee-dialog.tsx already calls — only
 * Super Admin may create a Supervisor account or set branch_ids outside the
 * caller's own scope (employees.service.ts's createEmployee), so this
 * dialog is the only place that role/branch pairing can happen. One atomic
 * backend call creates the user, sets the role, and writes every branch
 * assignment together (employees.repository.ts's createInTx) — there's no
 * separate "create" then "assign" step to leave half-finished on failure.
 */
export function AdminCreateEmployeeDialog({ open, onOpenChange }: AdminCreateEmployeeDialogProps) {
  const createEmployee = useCreateEmployee();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const branches = branchData?.branches ?? [];

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const role = form.watch('role') as CreatableRole;
  const branchIds = form.watch('branch_ids');

  useEffect(() => {
    if (open) form.reset(DEFAULT_VALUES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleRoleChange(nextRole: string) {
    form.setValue('role', nextRole as CreatableRole);
    // Staff is single-branch (Branch Employee Authorization) — clear the
    // selection on role switch instead of silently truncating it.
    form.setValue('branch_ids', [], { shouldValidate: true });
  }

  function toggleBranch(branchId: string, checked: boolean) {
    if (role === ROLES.STAFF) {
      form.setValue('branch_ids', checked ? [branchId] : [], { shouldValidate: true });
      return;
    }
    const next = checked ? [...branchIds, branchId] : branchIds.filter((id) => id !== branchId);
    form.setValue('branch_ids', next, { shouldValidate: true });
  }

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createEmployee.mutateAsync({
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      email: parsed.role === ROLES.SUPERVISOR ? parsed.email : undefined,
      initial_password: parsed.role === ROLES.SUPERVISOR ? parsed.initial_password : undefined,
      phone: parsed.phone,
      role: parsed.role,
      employment_type: parsed.employment_type,
      branch_ids: parsed.branch_ids,
      position: parsed.role === ROLES.STAFF ? parsed.position : undefined,
      notes: parsed.notes || undefined,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Employee</DialogTitle>
          <DialogDescription>Create a login account and assign branch access.</DialogDescription>
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

            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Role<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <Select value={field.value} onValueChange={handleRoleChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CREATABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {role === ROLES.SUPERVISOR && (
              <div className="grid grid-cols-2 gap-3">
                <FormFieldWrapper<FormValues> name="email" label="Email" required>
                  <Input type="email" placeholder="juan@example.com" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="initial_password" label="Password" required>
                  <Input type="password" placeholder="••••••••" />
                </FormFieldWrapper>
              </div>
            )}

            {role === ROLES.STAFF && (
              <FormFieldWrapper<FormValues> name="position" label="Position" required>
                <Input placeholder="Cashier" />
              </FormFieldWrapper>
            )}

            <div className="grid grid-cols-2 gap-3">
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
                  <FormDescription>
                    {role === ROLES.SUPERVISOR
                      ? 'Select one or more active branches this Supervisor can access.'
                      : 'Select the branch this employee belongs to.'}
                  </FormDescription>
                  {branchesLoading ? (
                    <p className="text-sm text-muted-foreground">Loading branches...</p>
                  ) : branches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active branches available.</p>
                  ) : (
                    <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                      {branches.map((branch) => (
                        <label key={branch.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={branchIds.includes(branch.id)}
                            onCheckedChange={(checked) => toggleBranch(branch.id, checked === true)}
                          />
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
              <Textarea placeholder="Internal notes about this employee" />
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createEmployee.isPending}>
                {createEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Employee
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
