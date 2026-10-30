'use client';

import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { usePayRates, usePayrollSettings } from '@/hooks/queries/use-payroll';
import { PayrollPolicyForm } from './payroll-policy-form';
import { PayrollRatesTable } from './payroll-rates-table';

/** Pay settings for one branch: the versioned payroll policy and effective-dated hourly rates. */
export function PayrollSettingsPanel({ branchId }: { branchId: string }) {
  const settings = usePayrollSettings(branchId);
  const rates = usePayRates(branchId);

  if (settings.isLoading || rates.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading pay settings…
      </p>
    );
  }
  if (settings.isError || rates.isError || !settings.data || !rates.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load pay settings</AlertTitle>
        <AlertDescription>{settings.error?.message ?? rates.error?.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="grid gap-4">
      <PayrollPolicyForm branchId={branchId} settings={settings.data} />
      <PayrollRatesTable branchId={branchId} data={rates.data} />
      {settings.data.history.length > 1 && (
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Policy history ({settings.data.history.length} versions)</summary>
          <ul className="mt-2 grid gap-1 text-muted-foreground">
            {settings.data.history.map((h) => (
              <li key={h.version} className="break-words">
                v{h.version} · {h.timezone} · {h.period_type === 'monthly' ? 'monthly' : `semi-monthly (cutoff ${h.semi_monthly_first_end_day})`} · breaks {h.break_treatment.replace(/_/g, ' ')}
                {h.paid_break_limit_minutes !== null ? ` (${h.paid_break_limit_minutes} min)` : ''} — {h.created_by_name}, {new Date(h.created_at).toLocaleString('en-PH')}
                {h.change_reason ? ` — “${h.change_reason}”` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
