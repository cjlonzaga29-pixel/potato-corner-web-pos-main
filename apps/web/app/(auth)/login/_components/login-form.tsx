'use client';

import { useEffect, useState, type FormEvent } from 'react';
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
import { useVerify2FALogin, useVerify2FABackupCode, ApiRequestError } from '@/hooks/queries/use-2fa';
import { hasRegisteredDevice, getOrCreateDeviceId } from '@/lib/device';
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

interface ChallengeUser {
  role: keyof typeof ROLE_DASHBOARD_PATHS;
}

/** Step 11b Phase 2: which screen the form is showing — 'credentials' is the unchanged pre-2FA flow. */
type Stage = 'credentials' | 'totp' | 'backup';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, completeLogin } = useAuth();
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

  const [stage, setStage] = useState<Stage>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [challengeExpiresAt, setChallengeExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [totpCode, setTotpCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [lowBackupCodesWarning, setLowBackupCodesWarning] = useState(false);

  const verifyLogin = useVerify2FALogin();
  const verifyBackupCode = useVerify2FABackupCode();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginFormSchema) });

  function redirectAfterLogin(user: ChallengeUser) {
    const returnTo = getSafeReturnTo(searchParams.get('returnTo'));
    router.push(returnTo ?? ROLE_DASHBOARD_PATHS[user.role] ?? '/');
  }

  async function onSubmit(values: LoginFormValues) {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await login(values.email, values.password);
      if (result.challengeRequired) {
        setChallengeToken(result.challengeToken);
        setChallengeExpiresAt(Date.now() + result.expiresIn * 1000);
        setChallengeError(null);
        setStage('totp');
        return;
      }
      redirectAfterLogin(result.user);
    } catch (err) {
      setError(parseLoginError(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  // Countdown timer for the challenge window — on expiry, bounce back to the
  // credentials form rather than leaving a dead TOTP screen up.
  useEffect(() => {
    if (stage === 'credentials' || challengeExpiresAt === null) return;

    function tick() {
      const remaining = Math.max(0, Math.round(((challengeExpiresAt as number) - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        setStage('credentials');
        setError({ message: 'Session expired — please log in again' });
      }
    }

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [stage, challengeExpiresAt]);

  function handleChallengeError(err: unknown) {
    if (err instanceof ApiRequestError) {
      if (err.code === 'CHALLENGE_INVALID') {
        setStage('credentials');
        setError({ message: 'Session expired — please log in again' });
        return;
      }
      if (err.code === 'RATE_LIMIT_EXCEEDED') {
        setChallengeError('Too many attempts. Please try again later.');
        return;
      }
      setChallengeError(err.message);
      return;
    }
    setChallengeError('Something went wrong. Please check your connection and try again.');
  }

  async function onSubmitTotp(event: FormEvent) {
    event.preventDefault();
    setChallengeError(null);
    try {
      const data = await verifyLogin.mutateAsync({ challengeToken, totpCode, deviceId: getOrCreateDeviceId() });
      const user = completeLogin(data.access_token, data.user);
      redirectAfterLogin(user);
    } catch (err) {
      handleChallengeError(err);
    }
  }

  async function onSubmitBackupCode(event: FormEvent) {
    event.preventDefault();
    setChallengeError(null);
    try {
      const data = await verifyBackupCode.mutateAsync({ challengeToken, backupCode, deviceId: getOrCreateDeviceId() });
      if (data.low_backup_codes_warning) setLowBackupCodesWarning(true);
      const user = completeLogin(data.access_token, data.user);
      redirectAfterLogin(user);
    } catch (err) {
      handleChallengeError(err);
    }
  }

  if (stage !== 'credentials') {
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;

    return (
      <div className="flex flex-col gap-4">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Two-Factor Authentication</h2>
          <p className="text-sm text-muted-foreground">
            {stage === 'totp'
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Enter one of your backup codes.'}
          </p>
        </div>

        {lowBackupCodesWarning && (
          <p role="alert" className="rounded-lg bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-300">
            You have 2 or fewer backup codes remaining. Regenerate them from your account settings soon.
          </p>
        )}

        {stage === 'totp' ? (
          <form onSubmit={onSubmitTotp} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="totp-code">Authentication code</Label>
              <Input
                id="totp-code"
                inputMode="numeric"
                autoFocus
                autoComplete="one-time-code"
                maxLength={6}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
              />
            </div>

            {challengeError && <p className="text-sm text-destructive">{challengeError}</p>}

            <p className="text-center text-xs text-muted-foreground">
              Challenge expires in {minutes}:{seconds.toString().padStart(2, '0')}
            </p>

            <Button type="submit" disabled={verifyLogin.isPending || totpCode.length !== 6}>
              {verifyLogin.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
            </Button>

            <button
              type="button"
              className="text-center text-sm text-muted-foreground hover:underline"
              onClick={() => {
                setStage('backup');
                setChallengeError(null);
              }}
            >
              Use backup code instead
            </button>
          </form>
        ) : (
          <form onSubmit={onSubmitBackupCode} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="backup-code">Backup code</Label>
              <Input
                id="backup-code"
                autoFocus
                maxLength={10}
                value={backupCode}
                onChange={(event) => setBackupCode(event.target.value.toUpperCase())}
              />
            </div>

            {challengeError && <p className="text-sm text-destructive">{challengeError}</p>}

            <p className="text-center text-xs text-muted-foreground">
              Challenge expires in {minutes}:{seconds.toString().padStart(2, '0')}
            </p>

            <Button type="submit" disabled={verifyBackupCode.isPending || backupCode.length !== 10}>
              {verifyBackupCode.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
            </Button>

            <button
              type="button"
              className="text-center text-sm text-muted-foreground hover:underline"
              onClick={() => {
                setStage('totp');
                setChallengeError(null);
              }}
            >
              Use authentication code instead
            </button>
          </form>
        )}
      </div>
    );
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
          <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
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
