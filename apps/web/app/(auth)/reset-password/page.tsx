'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestValues>({ resolver: zodResolver(requestSchema) });

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
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>
      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send reset link'}
      </Button>
    </form>
  );
}

function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({ resolver: zodResolver(resetSchema) });
  const newPassword = watch('new_password') ?? '';

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
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new_password">New password</Label>
        <Input id="new_password" type="password" autoComplete="new-password" {...register('new_password')} />
        {errors.new_password && <p className="text-sm text-destructive">{errors.new_password.message}</p>}
      </div>

      <ul className="space-y-1 text-xs">
        {PASSWORD_RULES.map((rule) => (
          <li key={rule.label} className={rule.test(newPassword) ? 'text-green-600' : 'text-muted-foreground'}>
            {rule.test(newPassword) ? '✓' : '·'} {rule.label}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm_password">Confirm password</Label>
        <Input id="confirm_password" type="password" autoComplete="new-password" {...register('confirm_password')} />
        {errors.confirm_password && <p className="text-sm text-destructive">{errors.confirm_password.message}</p>}
      </div>

      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reset password'}
      </Button>
    </form>
  );
}

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  return (
    <Card className="w-full max-w-sm">
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
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Suspense fallback={null}>
        <ResetPasswordContent />
      </Suspense>
    </main>
  );
}
