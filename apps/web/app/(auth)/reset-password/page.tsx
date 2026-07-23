'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { apiClient } from '@/lib/api-client';

const requestSchema = z.object({ email: z.email('Enter a valid email address') });
type RequestValues = z.infer<typeof requestSchema>;

const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (v: string) => v.length >= 8 },
  { label: 'One uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { label: 'One lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { label: 'One number', test: (v: string) => /[0-9]/.test(v) },
];

const resetSchema = z
  .object({
    new_password: z.string().min(8),
    confirm_password: z.string(),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });
type ResetValues = z.infer<typeof resetSchema>;

function RequestResetForm() {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<RequestValues>({ resolver: zodResolver(requestSchema), defaultValues: { email: '' } });
  const { isSubmitting } = form.formState;

  async function onSubmit(values: RequestValues) {
    setError(null);
    try {
      await apiClient('/api/auth/request-reset', { method: 'POST', body: JSON.stringify(values) });
      // Always show the same success state — never confirm whether the email exists.
      setSubmitted(true);
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  if (submitted) {
    return (
      <p className="text-sm text-muted-foreground">
        If an account exists for that email, a reset link has been sent. Check your inbox.
      </p>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <FormFieldWrapper<RequestValues> name="email" label="Email">
          <Input type="email" autoComplete="email" />
        </FormFieldWrapper>

        {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send reset link'}
        </Button>
      </form>
    </Form>
  );
}

function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { new_password: '', confirm_password: '' },
  });
  const { isSubmitting } = form.formState;
  const newPassword = form.watch('new_password') ?? '';

  async function onSubmit(values: ResetValues) {
    setError(null);
    try {
      const response = await apiClient('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, ...values }),
      });
      if (!response.data) {
        setError('This reset link is invalid or has expired. Request a new one.');
        return;
      }
      router.push('/login');
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <FormFieldWrapper<ResetValues> name="new_password" label="New password">
          <Input type="password" autoComplete="new-password" />
        </FormFieldWrapper>

        <ul className="space-y-1 text-xs">
          {PASSWORD_RULES.map((rule) => (
            <li key={rule.label} className={rule.test(newPassword) ? 'text-green-600' : 'text-muted-foreground'}>
              {rule.test(newPassword) ? '✓' : '·'} {rule.label}
            </li>
          ))}
        </ul>

        <FormFieldWrapper<ResetValues> name="confirm_password" label="Confirm password">
          <Input type="password" autoComplete="new-password" />
        </FormFieldWrapper>

        {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reset password'}
        </Button>
      </form>
    </Form>
  );
}

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  return (
    <Card className="glass-panel relative w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{token ? 'Reset your password' : 'Forgot password'}</CardTitle>
        <CardDescription>
          {token ? 'Choose a new password for your account.' : "We'll email you a link to reset your password."}
        </CardDescription>
      </CardHeader>
      <CardContent>{token ? <ResetPasswordForm token={token} /> : <RequestResetForm />}</CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="bg-grid-fade relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div
        className="pointer-events-none absolute left-1/2 top-1/3 h-[32rem] w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20 blur-3xl"
        aria-hidden="true"
      />
      <Suspense fallback={null}>
        <ResetPasswordContent />
      </Suspense>
    </main>
  );
}
