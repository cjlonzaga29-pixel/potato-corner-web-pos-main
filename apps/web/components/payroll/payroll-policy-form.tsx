'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PayrollBreakTreatment, PayrollPeriodType, PayrollSettingsResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useSavePayrollPolicy } from '@/hooks/queries/use-payroll';
import { BREAK_TREATMENT_LABELS, PAYROLL_TIMEZONE_SUGGESTIONS } from '@/lib/payroll-format';

interface Props {
  branchId: string;
  settings: PayrollSettingsResponse;
}

/**
 * Branch payroll policy. Nothing is pre-selected when the branch has no
 * policy: the reviewer must choose a period scheme and a break treatment
 * explicitly. Saving sends the version this form loaded, so a policy changed
 * elsewhere in the meantime is refused instead of overwritten.
 */
export function PayrollPolicyForm({ branchId, settings }: Props) {
  const policy = settings.policy;
  const [timezone, setTimezone] = useState(policy?.timezone ?? '');
  const [periodType, setPeriodType] = useState<PayrollPeriodType | ''>(policy?.period_type ?? '');
  const [cutoff, setCutoff] = useState(policy?.semi_monthly_first_end_day ? String(policy.semi_monthly_first_end_day) : '');
  const [treatment, setTreatment] = useState<PayrollBreakTreatment | ''>(policy?.break_treatment ?? '');
  const [limit, setLimit] = useState(policy?.paid_break_limit_minutes !== null && policy?.paid_break_limit_minutes !== undefined ? String(policy.paid_break_limit_minutes) : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useSavePayrollPolicy(branchId);

  useEffect(() => {
    setTimezone(policy?.timezone ?? '');
    setPeriodType(policy?.period_type ?? '');
    setCutoff(policy?.semi_monthly_first_end_day ? String(policy.semi_monthly_first_end_day) : '');
    setTreatment(policy?.break_treatment ?? '');
    setLimit(policy?.paid_break_limit_minutes !== null && policy?.paid_break_limit_minutes !== undefined ? String(policy.paid_break_limit_minutes) : '');
    setReason('');
    setError(null);
  }, [policy]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!timezone.trim()) return setError('Choose the business timezone.');
    if (!periodType) return setError('Choose the pay period.');
    if (periodType === 'semi_monthly' && !/^\d+$/.test(cutoff)) return setError('Enter the first cutoff day (1–27).');
    if (!treatment) return setError('Choose how breaks are treated.');
    if (treatment === 'paid_up_to_limit' && !/^\d+$/.test(limit)) return setError('Enter the paid break minutes per shift.');
    save.mutate({
      timezone: timezone.trim(),
      period_type: periodType,
      semi_monthly_first_end_day: periodType === 'semi_monthly' ? Number(cutoff) : null,
      break_treatment: treatment,
      paid_break_limit_minutes: treatment === 'paid_up_to_limit' ? Number(limit) : null,
      expected_version: policy?.version ?? 0,
      change_reason: reason.trim() || undefined,
    });
  }

  const cutoffNumber = Number(cutoff);
  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Payroll policy</CardTitle>
          {policy ? <Badge variant="secondary">Version {policy.version}</Badge> : <Badge variant="warning">Not configured</Badge>}
        </div>
        <CardDescription>
          {policy
            ? `Last changed by ${policy.created_by_name} on ${new Date(policy.created_at).toLocaleString('en-PH')}. Changes apply to drafts; finalized payroll keeps the policy it used.`
            : 'This branch has no payroll policy. Payroll cannot be generated until one is saved — nothing is assumed.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="payroll-timezone">Business timezone</Label>
            <Input
              id="payroll-timezone"
              list="payroll-timezone-options"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="e.g. Asia/Manila"
              className="sm:max-w-xs"
              autoComplete="off"
            />
            <datalist id="payroll-timezone-options">
              {PAYROLL_TIMEZONE_SUGGESTIONS.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">Decides business dates, cutoffs, rate start dates and the night-hours flag.</p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Pay period</legend>
            <RadioGroup value={periodType} onValueChange={(v) => setPeriodType(v as PayrollPeriodType)} className="grid gap-2 sm:grid-cols-2">
              <Label htmlFor="period-semi" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal">
                <RadioGroupItem id="period-semi" value="semi_monthly" />
                Semi-monthly (two cutoffs)
              </Label>
              <Label htmlFor="period-monthly" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal">
                <RadioGroupItem id="period-monthly" value="monthly" />
                Monthly
              </Label>
            </RadioGroup>
            {periodType === 'semi_monthly' && (
              <div className="grid gap-2 sm:max-w-xs">
                <Label htmlFor="payroll-cutoff">First cutoff day</Label>
                <Input id="payroll-cutoff" inputMode="numeric" value={cutoff} onChange={(e) => setCutoff(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="15" />
                {cutoffNumber >= 1 && cutoffNumber <= 27 && (
                  <p className="text-xs text-muted-foreground">
                    Periods: 1–{cutoffNumber} and {cutoffNumber + 1}–end of month.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Break treatment</legend>
            <RadioGroup value={treatment} onValueChange={(v) => setTreatment(v as PayrollBreakTreatment)} className="grid gap-2 md:grid-cols-3">
              {(['unpaid', 'paid', 'paid_up_to_limit'] as const).map((value) => (
                <Label key={value} htmlFor={`break-${value}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal">
                  <RadioGroupItem id={`break-${value}`} value={value} />
                  {BREAK_TREATMENT_LABELS[value]}
                </Label>
              ))}
            </RadioGroup>
            {treatment === 'paid_up_to_limit' && (
              <div className="grid gap-2 sm:max-w-xs">
                <Label htmlFor="payroll-break-limit">Paid break minutes per shift</Label>
                <Input id="payroll-break-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="15" />
                <p className="text-xs text-muted-foreground">The first minutes of break in each shift are paid; the rest is unpaid.</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Recorded break times (Start Break / Resume Work) are used when they exist. Older records with only a break total use that total. Never both.
            </p>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor="payroll-policy-reason">Reason for change (optional)</Label>
            <Input id="payroll-policy-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" disabled={save.isPending} className="w-full sm:w-auto">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Save policy
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
