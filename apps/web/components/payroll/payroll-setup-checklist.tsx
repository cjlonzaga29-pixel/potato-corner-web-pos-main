'use client';

import { useState } from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import type { PayRateEmployeeView, PayRatesResponse, PayrollSettingsResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { BREAK_TREATMENT_LABELS, describePayPeriod } from '@/lib/payroll-format';
import { cn } from '@/lib/utils';
import { PayrollRateDialog } from './payroll-rate-dialog';

interface Props {
  branchId: string;
  settings: PayrollSettingsResponse | undefined;
  rates: PayRatesResponse | undefined;
  /** Opens the existing Payroll Settings forms; they return to the payroll flow after saving. */
  onOpenSettings: () => void;
  /** Read-only viewers see the checklist without Set up / Edit actions. */
  editable?: boolean;
  /** Settings or rates could not be loaded; offer a retry instead of guessing what is missing. */
  loadError?: boolean;
  onRetry?: () => void;
}

interface Item {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
}

/**
 * POS-PERF-P66 — compact readiness checklist built only from settings the
 * branch has actually saved. Nothing is assumed: a missing item says so and
 * links to the existing form; it is never shown as zero pay.
 */
export function PayrollSetupChecklist({ branchId, settings, rates, onOpenSettings, editable = true, loadError = false, onRetry }: Props) {
  const [rateFor, setRateFor] = useState<PayRateEmployeeView | null>(null);
  const policy = settings?.policy ?? null;
  const current = rates?.employees.filter((e) => e.assignment === 'current' && e.employee_active) ?? [];
  const missingRates = current.filter((e) => e.current_rate === null);

  const items: Item[] = [
    {
      id: 'policy',
      label: 'Branch payroll policy',
      ready: policy !== null,
      detail: policy ? `Version ${policy.version} · business timezone ${policy.timezone}` : 'Not saved yet. Payroll cannot be prepared until it is.',
    },
    {
      id: 'period',
      label: 'Pay period and cutoff',
      ready: policy !== null,
      detail: policy ? describePayPeriod(policy.period_type, policy.semi_monthly_first_end_day) : 'Not chosen yet.',
    },
    {
      id: 'breaks',
      label: 'Paid or unpaid breaks',
      ready: policy !== null,
      detail: policy
        ? `${BREAK_TREATMENT_LABELS[policy.break_treatment]}${policy.paid_break_limit_minutes !== null ? ` (${policy.paid_break_limit_minutes} min per shift)` : ''}`
        : 'Not chosen yet.',
    },
    {
      id: 'rates',
      label: 'Employee hourly rates',
      ready: missingRates.length === 0,
      detail:
        current.length === 0
            ? 'No current staff at this branch.'
            : missingRates.length === 0
              ? `All ${current.length} current staff have a rate in effect today.`
              : `${missingRates.length} of ${current.length} current staff have no rate in effect today. Their hours are not paid at ₱0 — finalizing is blocked until a rate covers them.`,
    },
  ];
  const missing = items.filter((i) => !i.ready).length;

  if (loadError) {
    return (
      <p className="rounded-lg border p-3 text-sm text-destructive" role="alert" data-testid="payroll-setup-checklist">
        Could not check the payroll setup.{' '}
        {onRetry && (
          <button type="button" className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onRetry}>
            Try again
          </button>
        )}
      </p>
    );
  }
  if (settings === undefined || rates === undefined) {
    return (
      <p className="text-sm text-muted-foreground" role="status" data-testid="payroll-setup-checklist">
        Checking payroll setup…
      </p>
    );
  }

  const list = (
    <ul className="mt-2 grid gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid={`payroll-setup-${item.id}`} data-ready={item.ready}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', item.ready ? 'bg-emerald-600' : 'bg-amber-500')} aria-hidden="true" />
              {item.label}
              <span className="sr-only">{item.ready ? '(ready)' : '(needs setup)'}</span>
            </div>
            <p className="break-words text-muted-foreground">{item.detail}</p>
            {item.id === 'rates' && missingRates.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-2" aria-label="Staff without a rate">
                {missingRates.map((employee) => (
                  <li key={employee.employee_id}>
                    {editable ? (
                      <Button type="button" size="sm" variant="outline" className="min-h-10" onClick={() => setRateFor(employee)}>
                        Set rate<span className="sr-only"> for</span>
                        <span aria-hidden="true">:</span> {employee.name}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">{employee.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {editable && (
            <Button type="button" size="sm" variant={item.ready ? 'ghost' : 'default'} className="min-h-10 w-full shrink-0 sm:w-auto" onClick={onOpenSettings}>
              {item.ready ? 'Edit' : 'Set up'}
              <span className="sr-only"> {item.label.toLowerCase()}</span>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
  const dialog = editable && (
    <PayrollRateDialog key={rateFor?.employee_id ?? 'none'} branchId={branchId} employee={rateFor} today={rates?.today ?? null} onOpenChange={(open) => !open && setRateFor(null)} />
  );

  // Ready: one collapsed line, so setup does not crowd the payroll steps.
  if (missing === 0) {
    return (
      <details className="rounded-lg border px-3 py-2 text-sm sm:px-4" data-testid="payroll-setup-checklist" data-ready="true">
        <summary className="flex cursor-pointer items-center gap-2 rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          Payroll setup is ready
        </summary>
        {list}
        {dialog}
      </details>
    );
  }

  return (
    <section aria-labelledby="payroll-setup-heading" className="rounded-lg border p-3 sm:p-4" data-testid="payroll-setup-checklist" data-ready="false">
      <h2 id="payroll-setup-heading" className="flex items-center gap-2 text-sm font-semibold">
        <CircleAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
        Payroll setup: {missing} item{missing === 1 ? '' : 's'} to finish
      </h2>
      {list}
      {dialog}
    </section>
  );
}
