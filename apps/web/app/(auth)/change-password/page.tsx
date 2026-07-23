'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { ROLE_DASHBOARDS, type Role } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { apiClient } from '@/lib/api-client';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (v: string) => v.length >= 8 },
  { label: 'One uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { label: 'One lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { label: 'One number', test: (v: string) => /[0-9]/.test(v) },
  { label: 'One special character', test: (v: string) => /[^A-Za-z0-9]/.test(v) },
];

const formSchema = z
  .object({
    current_password: z.string().min(8, 'Enter your current password'),
    new_password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
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

interface ChangePasswordResponseData {
  access_token: string;
  user: {
    id: string;
    role: Role;
    email: string;
    first_name: string;
    last_name: string;
    branch_ids: string[];
    must_change_password: boolean;
  };
}

const REDIRECT_STORAGE_KEY = 'pc_redirect_after_password_change';

function strengthScore(password: string): number {
  const passed = PASSWORD_RULES.filter((rule) => rule.test(password)).length;
  return Math.round((passed / PASSWORD_RULES.length) * 100);
}

function strengthColorClass(score: number): string {
  if (score < 40) return '[&>div]:bg-destructive';
  if (score < 100) return '[&>div]:bg-yellow-500';
  return '[&>div]:bg-green-600';
}

export default function ChangePasswordPage() {
  const router = useRouter();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { current_password: '', new_password: '', confirm_password: '' },
  });
  const newPassword = form.watch('new_password') ?? '';
  const score = strengthScore(newPassword);
  const { isSubmitting } = form.formState;

  async function onSubmit(values: FormValues) {
    setError(null);
    let response;
    try {
      response = await apiClient<ChangePasswordResponseData>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(values),
      });
    } catch {
      setError('Something went wrong. Please try again.');
      return;
    }

    if (!response.data) {
      setError(
        typeof response.error === 'string'
          ? response.error
          : (response.error?.message ?? 'Current password is incorrect.'),
      );
      return;
    }

    const { user, access_token } = response.data;
    const authUser: AuthUser = {
      id: user.id,
      role: user.role,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      branchIds: user.branch_ids,
    };
    setAuth(authUser, access_token);

    const storedRedirect = typeof window !== 'undefined' ? sessionStorage.getItem(REDIRECT_STORAGE_KEY) : null;
    if (storedRedirect) sessionStorage.removeItem(REDIRECT_STORAGE_KEY);

    const destination = storedRedirect && storedRedirect !== '/change-password' ? storedRedirect : ROLE_DASHBOARDS[user.role];
    router.push(destination);
  }

  return (
    <main className="bg-grid-fade relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div
        className="pointer-events-none absolute left-1/2 top-1/3 h-[32rem] w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20 blur-3xl"
        aria-hidden="true"
      />
      <Card className="glass-panel relative w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Set a new password</CardTitle>
          <CardDescription>
            Your account requires a new password before you can continue. This step can&apos;t be skipped.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
              <FormFieldWrapper<FormValues> name="current_password" label="Current password">
                <Input type="password" autoComplete="current-password" />
              </FormFieldWrapper>

              <FormField
                control={form.control}
                name="new_password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    {newPassword.length > 0 && <Progress value={score} className={`h-1.5 ${strengthColorClass(score)}`} />}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <ul className="space-y-1 text-xs">
                {PASSWORD_RULES.map((rule) => (
                  <li key={rule.label} className={rule.test(newPassword) ? 'text-green-600' : 'text-muted-foreground'}>
                    {rule.test(newPassword) ? '✓' : '·'} {rule.label}
                  </li>
                ))}
              </ul>

              <FormFieldWrapper<FormValues> name="confirm_password" label="Confirm new password">
                <Input type="password" autoComplete="new-password" />
              </FormFieldWrapper>

              {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Set new password'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}
