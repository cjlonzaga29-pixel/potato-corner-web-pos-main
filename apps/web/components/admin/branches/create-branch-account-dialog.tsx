'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { ROLES, strongPasswordSchema, type BranchResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useCreateEmployee } from '@/hooks/queries/use-employees';

const formSchema = z
  .object({
    email: z.email('Must be a valid email'),
    password: strongPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

type FormValues = z.input<typeof formSchema>;

interface CreateBranchAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: Pick<BranchResponse, 'id' | 'name'>;
}

/**
 * POS-PERF-P40 — provisions a login for a branch that has none (normally the
 * account is created together with the branch). Reuses POST /api/employees
 * with role `branch`, which the server restricts to Super Admin
 * (employees.service.ts createEmployee) and audits as EMPLOYEE_CREATED. The
 * typed password is sent once and never shown again.
 */
export function CreateBranchAccountDialog({ open, onOpenChange, branch }: CreateBranchAccountDialogProps) {
  const queryClient = useQueryClient();
  const createEmployee = useCreateEmployee();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '', password: '', confirmPassword: '' },
  });

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createEmployee.mutateAsync({
      role: ROLES.BRANCH,
      email: parsed.email,
      initial_password: parsed.password,
      employment_type: 'regular',
      branch_ids: [branch.id],
    });
    void queryClient.invalidateQueries({ queryKey: ['branches'] });
    form.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create branch account</DialogTitle>
          <DialogDescription>Login for {branch.name}&apos;s POS.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="email" label="Username (email)" required>
              <Input type="email" autoComplete="off" placeholder="branch.name@potatocorner.com" />
            </FormFieldWrapper>
            <FormFieldWrapper<FormValues> name="password" label="Password" required>
              <Input type="password" autoComplete="new-password" />
            </FormFieldWrapper>
            <FormFieldWrapper<FormValues> name="confirmPassword" label="Confirm password" required>
              <Input type="password" autoComplete="new-password" />
            </FormFieldWrapper>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createEmployee.isPending}>
                {createEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create account
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
