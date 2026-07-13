'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { EMPLOYMENT_TYPE, ROLES, ROLE_LABELS, philippineMobileSchema, type EmploymentType, type Role } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useBranches } from '@/hooks/queries/use-branches';
import { useCreateEmployee } from '@/hooks/queries/use-employees';

const phoneField = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  philippineMobileSchema.optional(),
);

const formSchema = z.object({
  first_name: z.string().min(2, 'Minimum 2 characters').max(50),
  last_name: z.string().min(2, 'Minimum 2 characters').max(50),
  email: z.email(),
  phone: phoneField,
  role: z.enum([ROLES.SUPER_ADMIN, ROLES.SUPERVISOR, ROLES.STAFF]),
  employment_type: z.enum([EMPLOYMENT_TYPE.REGULAR, EMPLOYMENT_TYPE.CONTRACTUAL, EMPLOYMENT_TYPE.PART_TIME]),
  branch_ids: z.array(z.string()).min(1, 'Select at least one branch'),
  sss_number: z.string().optional(),
  philhealth_number: z.string().optional(),
  tin_number: z.string().optional(),
  pagibig_number: z.string().optional(),
  initial_password: z.string().min(8, 'Minimum 8 characters'),
});

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  role: ROLES.STAFF,
  employment_type: EMPLOYMENT_TYPE.REGULAR,
  branch_ids: [],
  sss_number: '',
  philhealth_number: '',
  tin_number: '',
  pagibig_number: '',
  initial_password: '',
};

const STEP_FIELDS: Record<number, (keyof FormValues)[]> = {
  1: ['first_name', 'last_name', 'email', 'phone', 'role', 'employment_type'],
  2: ['branch_ids'],
  3: ['sss_number', 'philhealth_number', 'tin_number', 'pagibig_number', 'initial_password'],
};

const STEP_LABELS = ['Basic Information', 'Branch Assignment', 'Government IDs & Password'];

function passwordStrength(password: string): number {
  let score = 0;
  if (password.length >= 8) score += 25;
  if (/[A-Z]/.test(password)) score += 25;
  if (/[0-9]/.test(password)) score += 25;
  if (/[^A-Za-z0-9]/.test(password)) score += 25;
  return score;
}

interface CreateEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateEmployeeDialog({ open, onOpenChange }: CreateEmployeeDialogProps) {
  const [step, setStep] = useState(1);
  const [showPassword, setShowPassword] = useState(false);
  const createEmployee = useCreateEmployee();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const password = form.watch('initial_password') ?? '';
  const selectedBranchIds = form.watch('branch_ids') ?? [];

  function handleOpenChange(next: boolean) {
    if (!next) {
      form.reset(DEFAULT_VALUES);
      setStep(1);
      setShowPassword(false);
    }
    onOpenChange(next);
  }

  async function handleNext() {
    const valid = await form.trigger(STEP_FIELDS[step]);
    if (valid) setStep((current) => Math.min(current + 1, 3));
  }

  function handleBack() {
    setStep((current) => Math.max(current - 1, 1));
  }

  function toggleBranch(branchId: string, checked: boolean) {
    const next = checked ? [...selectedBranchIds, branchId] : selectedBranchIds.filter((id) => id !== branchId);
    form.setValue('branch_ids', next, { shouldValidate: true });
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createEmployee.mutateAsync({
      email: parsed.email,
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      phone: parsed.phone,
      role: parsed.role,
      employment_type: parsed.employment_type,
      branch_ids: parsed.branch_ids,
      sss_number: parsed.sss_number || undefined,
      philhealth_number: parsed.philhealth_number || undefined,
      tin_number: parsed.tin_number || undefined,
      pagibig_number: parsed.pagibig_number || undefined,
      initial_password: parsed.initial_password,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Employee</DialogTitle>
          <DialogDescription>
            Step {step} of 3 — {STEP_LABELS[step - 1]}
          </DialogDescription>
        </DialogHeader>

        <Progress value={(step / 3) * 100} className="h-1.5" />

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {step === 1 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <FormFieldWrapper<FormValues> name="first_name" label="First Name" required>
                    <Input placeholder="Juan" />
                  </FormFieldWrapper>
                  <FormFieldWrapper<FormValues> name="last_name" label="Last Name" required>
                    <Input placeholder="Dela Cruz" />
                  </FormFieldWrapper>
                </div>

                <FormFieldWrapper<FormValues> name="email" label="Email" required>
                  <Input type="email" placeholder="juan.delacruz@potatocorner.com" />
                </FormFieldWrapper>

                <FormFieldWrapper<FormValues> name="phone" label="Phone" description="Optional — +63XXXXXXXXXX format">
                  <Input placeholder="+639171234567" />
                </FormFieldWrapper>

                <div className="grid grid-cols-2 gap-3">
                  {/* Radix Select takes value/onValueChange, not the onChange FormFieldWrapper clones onto children — wired directly via Controller instead. */}
                  <FormField
                    control={form.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Role<span className="ml-0.5 text-destructive">*</span>
                        </FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(Object.values(ROLES) as Role[]).map((role) => (
                              <SelectItem key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

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
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Select every branch this employee should have access to.</p>
                {branchesLoading ? (
                  <div className="flex justify-center py-8">
                    <LoadingSpinner />
                  </div>
                ) : (
                  <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
                    {(branchData?.branches ?? []).map((branch) => (
                      <label key={branch.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selectedBranchIds.includes(branch.id)}
                          onCheckedChange={(checked) => toggleBranch(branch.id, checked === true)}
                        />
                        <span className="font-medium">{branch.name}</span>
                        <span className="text-xs text-muted-foreground">{branch.code}</span>
                      </label>
                    ))}
                  </div>
                )}
                {form.formState.errors.branch_ids && (
                  <p className="text-sm text-destructive">{form.formState.errors.branch_ids.message}</p>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Government ID fields are optional at creation and are encrypted before storage — they never appear in
                  standard employee views.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <FormFieldWrapper<FormValues> name="sss_number" label="SSS Number" description="Encrypted">
                    <Input placeholder="Optional" />
                  </FormFieldWrapper>
                  <FormFieldWrapper<FormValues> name="philhealth_number" label="PhilHealth Number" description="Encrypted">
                    <Input placeholder="Optional" />
                  </FormFieldWrapper>
                  <FormFieldWrapper<FormValues> name="tin_number" label="TIN" description="Encrypted">
                    <Input placeholder="Optional" />
                  </FormFieldWrapper>
                  <FormFieldWrapper<FormValues> name="pagibig_number" label="Pag-IBIG Number" description="Encrypted">
                    <Input placeholder="Optional" />
                  </FormFieldWrapper>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="initial_password">Initial Password</Label>
                  <div className="relative">
                    <Input
                      id="initial_password"
                      type={showPassword ? 'text' : 'password'}
                      className="pr-10"
                      {...form.register('initial_password')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-9 w-9"
                      onClick={() => setShowPassword((prev) => !prev)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  {password.length > 0 && <Progress value={passwordStrength(password)} className="h-1.5" />}
                  {form.formState.errors.initial_password && (
                    <p className="text-sm text-destructive">{form.formState.errors.initial_password.message}</p>
                  )}
                  <p className="text-xs text-muted-foreground">The employee must change this password on first login.</p>
                </div>
              </div>
            )}

            <DialogFooter>
              {step > 1 && (
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              {step < 3 ? (
                <Button type="button" onClick={() => void handleNext()}>
                  Next
                </Button>
              ) : (
                <Button type="submit" disabled={createEmployee.isPending}>
                  {createEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Employee
                </Button>
              )}
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
