'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { hasRegisteredDevice } from '@/lib/device';
import { ROLE_DASHBOARD_PATHS } from '@/lib/constants';

const loginFormSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

interface LoginErrorState {
  message: string;
  minutesRemaining?: number;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<LoginErrorState | null>(null);
  // Starts false to match the server-rendered HTML (no access to
  // localStorage during SSR), then updates after mount — reading
  // localStorage in the useState initializer itself would make the first
  // client render disagree with the server render whenever a device id
  // already exists, causing a hydration mismatch.
  const [deviceRegistered, setDeviceRegistered] = useState(false);
  useEffect(() => {
    setDeviceRegistered(hasRegisteredDevice());
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginFormSchema) });

  async function onSubmit(values: LoginFormValues) {
    setError(null);
    setIsSubmitting(true);
    try {
      const user = await login(values.email, values.password);
      const returnTo = getSafeReturnTo(searchParams.get('returnTo'));
      router.push(returnTo ?? ROLE_DASHBOARD_PATHS[user.role] ?? '/');
    } catch (err) {
      setError(parseLoginError(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
          {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              className="pr-10"
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error.message}
            {typeof error.minutesRemaining === 'number' ? ` (${error.minutesRemaining} min remaining)` : null}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
        </Button>

        <Link href="/reset-password" className="text-center text-sm text-muted-foreground hover:underline">
          Forgot password?
        </Link>
      </form>

      {deviceRegistered && (
        <Button variant="outline" disabled title="PIN entry UI lands alongside the PIN-set flow in a later phase">
          Sign in with PIN
        </Button>
      )}
    </div>
  );
}

/**
 * Only a same-origin relative path is a safe post-login redirect target.
 * Rejects absolute URLs, protocol-relative URLs (`//evil.com`, which
 * browsers resolve as same-protocol absolute), and the backslash variant
 * (`/\evil.com`) some browsers also normalize to protocol-relative — all
 * of which would otherwise let a crafted login link redirect off-site
 * after a real login.
 */
function getSafeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/')) return null;
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return null;
  return value;
}

function parseLoginError(err: unknown): LoginErrorState {
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message) as { minutesRemaining?: number };
      return { message: err.message, minutesRemaining: parsed.minutesRemaining };
    } catch {
      return { message: err.message };
    }
  }
  return { message: 'Something went wrong. Please check your connection and try again.' };
}
