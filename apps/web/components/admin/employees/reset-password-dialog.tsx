'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import type { EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { useResetEmployeePassword } from '@/hooks/queries/use-employees';

const formSchema = z
  .object({
    new_password: z
      .string()
      .min(8, 'Minimum 8 characters')
      .regex(/[A-Z]/, 'Add an uppercase letter')
      .regex(/[a-z]/, 'Add a lowercase letter')
      .regex(/[0-9]/, 'Add a number')
      .regex(/[^A-Za-z0-9]/, 'Add a special character'),
    confirm_password: z.string(),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormValues = z.infer<typeof formSchema>;

function passwordStrength(password: string): number {
  let score = 0;
  if (password.length >= 8) score += 25;
  if (/[A-Z]/.test(password)) score += 25;
  if (/[0-9]/.test(password)) score += 25;
  if (/[^A-Za-z0-9]/.test(password)) score += 25;
  return score;
}

interface ResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

export function ResetPasswordDialog({ open, onOpenChange, employee }: ResetPasswordDialogProps) {
  const [showPassword, setShowPassword] = useState(false);
  const resetPassword = useResetEmployeePassword(employee.id);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { new_password: '', confirm_password: '' },
  });
  const password = form.watch('new_password') ?? '';

  function handleOpenChange(next: boolean) {
    if (!next) {
      form.reset({ new_password: '', confirm_password: '' });
      setShowPassword(false);
    }
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    await resetPassword.mutateAsync(values.new_password);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            {employee.first_name} {employee.last_name}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-new-password">New Password</Label>
            <div className="relative">
              <Input
                id="reset-new-password"
                type={showPassword ? 'text' : 'password'}
                className="pr-10"
                {...form.register('new_password')}
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
            {form.formState.errors.new_password && (
              <p className="text-sm text-destructive">{form.formState.errors.new_password.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reset-confirm-password">Confirm Password</Label>
            <Input
              id="reset-confirm-password"
              type={showPassword ? 'text' : 'password'}
              {...form.register('confirm_password')}
            />
            {form.formState.errors.confirm_password && (
              <p className="text-sm text-destructive">{form.formState.errors.confirm_password.message}</p>
            )}
          </div>

          <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
            The employee will be required to change this password on next login.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={resetPassword.isPending}>
              {resetPassword.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reset Password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
