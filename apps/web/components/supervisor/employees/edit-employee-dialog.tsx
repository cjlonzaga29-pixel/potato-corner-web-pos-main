'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { EMPLOYMENT_TYPE, ROLES, ROLE_LABELS, philippineMobileSchema, type EmployeeResponse, type EmploymentType } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useUpdateEmployee } from '@/hooks/queries/use-employees';

const phoneField = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  philippineMobileSchema.optional(),
);

// POS-PERF-P47 — the same dialog edits supervisors from the Super Admin
// console. Position is required for staff (cashier/crew job title) but
// supervisors often have none, so it is optional for them; a blank value is
// simply not sent (leaving the stored value as it was).
const positionField = z.string().max(100).refine((value) => value.trim() === '' || value.trim().length >= 2, 'Minimum 2 characters');

const formSchema = z.object({
  first_name: z.string().min(2, 'Minimum 2 characters').max(50),
  last_name: z.string().min(2, 'Minimum 2 characters').max(50),
  phone: phoneField,
  employment_type: z.enum([EMPLOYMENT_TYPE.REGULAR, EMPLOYMENT_TYPE.CONTRACTUAL, EMPLOYMENT_TYPE.PART_TIME]),
  position: positionField,
  notes: z.string().max(1000).optional(),
  sss_number: z.string().optional(),
  philhealth_number: z.string().optional(),
  tin_number: z.string().optional(),
  pagibig_number: z.string().optional(),
});

type FormValues = z.input<typeof formSchema>;

function toFormValues(employee: EmployeeResponse): FormValues {
  return {
    first_name: employee.first_name,
    last_name: employee.last_name,
    phone: employee.phone ?? '',
    employment_type: employee.employment_type,
    position: employee.position ?? '',
    notes: employee.notes ?? '',
    sss_number: '',
    philhealth_number: '',
    tin_number: '',
    pagibig_number: '',
  };
}

interface EditEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

/**
 * role and employee_id are deliberately not form fields — both are
 * immutable after creation (locked rule). Employees have no email (Branch
 * Employee Authorization) — Employee ID is shown in its place.
 */
const staffFormSchema = formSchema.refine((values) => values.position.trim().length > 0, {
  message: 'Position is required for staff',
  path: ['position'],
});

export function SupervisorEditEmployeeDialog({ open, onOpenChange, employee }: EditEmployeeDialogProps) {
  const updateEmployee = useUpdateEmployee(employee.id);
  const isStaff = employee.role === ROLES.STAFF;
  const schema = isStaff ? staffFormSchema : formSchema;
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toFormValues(employee) });

  useEffect(() => {
    if (open) form.reset(toFormValues(employee));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee.id]);

  async function onSubmit(values: FormValues) {
    const parsed = schema.parse(values);
    try {
      await updateEmployee.mutateAsync({
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        phone: parsed.phone,
        employment_type: parsed.employment_type,
        position: parsed.position.trim() || undefined,
        notes: parsed.notes || undefined,
        sss_number: parsed.sss_number || undefined,
        philhealth_number: parsed.philhealth_number || undefined,
        tin_number: parsed.tin_number || undefined,
        pagibig_number: parsed.pagibig_number || undefined,
      });
    } catch (saveError) {
      // Shown inline as well as in the toast, so the reason stays visible next to Save.
      form.setError('root', { message: saveError instanceof Error ? saveError.message : 'Failed to save changes' });
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {isStaff ? 'Employee' : ROLE_LABELS[employee.role]}</DialogTitle>
          <DialogDescription>Employee ID and role cannot be changed after creation.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>Employee ID</Label>
          <Input value={employee.employee_id} disabled readOnly className="font-mono" />
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="first_name" label="First Name" required>
                <Input />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="last_name" label="Last Name" required>
                <Input />
              </FormFieldWrapper>
            </div>

            <FormFieldWrapper<FormValues> name="phone" label="Contact Number" description="Optional — +63XXXXXXXXXX format">
              <Input placeholder="+639171234567" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="position" label="Position" required={isStaff} description={isStaff ? undefined : 'Optional'}>
              <Input placeholder={isStaff ? 'Cashier' : 'Area Supervisor'} />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="notes" label="Notes" description="Optional">
              <Textarea placeholder="Internal notes about this employee" />
            </FormFieldWrapper>

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

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                Government ID fields are shown blank for security. Fill in a field only to replace its encrypted value —
                leave it blank to keep the existing one unchanged.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <FormFieldWrapper<FormValues> name="sss_number" label="SSS Number">
                  <Input placeholder="Leave blank to keep unchanged" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="philhealth_number" label="PhilHealth Number">
                  <Input placeholder="Leave blank to keep unchanged" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="tin_number" label="TIN">
                  <Input placeholder="Leave blank to keep unchanged" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="pagibig_number" label="Pag-IBIG Number">
                  <Input placeholder="Leave blank to keep unchanged" />
                </FormFieldWrapper>
              </div>
            </div>

            {form.formState.errors.root?.message && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.root.message}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateEmployee.isPending}>
                {updateEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
