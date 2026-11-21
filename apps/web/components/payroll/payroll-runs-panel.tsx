'use client';

import { Loader2 } from 'lucide-react';
import type { PayrollPeriodOption, PayrollRunSummary } from '@potato-corner/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PayrollApiError, useCreatePayrollRun, usePayRates, usePayrollPeriods, usePayrollSettings } from '@/hooks/queries/use-payroll';
import { RUN_STATUS_LABELS, formatPayrollPeriod, formatPeso } from '@/lib/payroll-format';
import { PayrollRunView } from './payroll-run-view';
import { PayrollSetupChecklist } from './payroll-setup-checklist';

export interface PayrollSelection {
  periodKey: string | null;
  runId: string | null;
}

interface Props {
  branchId: string;
  /** Opens Payroll Settings; saving there returns here with the selection intact. */
  onConfigure: () => void;
  /** Lifted to the page so it survives a trip to Payroll Settings and resets when the branch changes. */
  selection: PayrollSelection;
  onSelectionChange: (next: PayrollSelection) => void;
}

const periodKeyOf = (p: PayrollPeriodOption) => `${p.period_start}|${p.period_end}`;
const liveRunOf = (p: PayrollPeriodOption | undefined) => p?.runs.find((r) => r.status === 'draft' || r.status === 'finalized');

function periodStatus(p: PayrollPeriodOption): { label: string; variant: 'active' | 'warning' | 'outline' } {
  if (p.runs.some((r) => r.status === 'finalized')) return { label: 'Finalized', variant: 'active' };
  if (p.runs.some((r) => r.status === 'draft')) return { label: 'Draft', variant: 'warning' };
  return { label: 'Not started', variant: 'outline' };
}

/**
 * POS-PERF-P66 — setup when needed, then three steps: choose the pay period,
 * review payroll, confirm finalization. Calculation, checks and finalization
 * are unchanged and live in the server and PayrollRunView.
 */
export function PayrollRunsPanel({ branchId, onConfigure, selection, onSelectionChange }: Props) {
  const periods = usePayrollPeriods(branchId);
  const settings = usePayrollSettings(branchId);
  const rates = usePayRates(branchId);
  const create = useCreatePayrollRun(branchId);

  if (periods.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading payroll…
      </p>
    );
  }
  if (periods.isError || !periods.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load payroll</AlertTitle>
        <AlertDescription className="grid gap-2">
          <span>{periods.error?.message}</span>
          <Button variant="outline" className="w-full sm:w-fit" onClick={() => void periods.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const checklist = (
    <PayrollSetupChecklist
      branchId={branchId}
      settings={settings.data}
      rates={rates.data}
      onOpenSettings={onConfigure}
      loadError={settings.isError || rates.isError}
      onRetry={() => {
        void settings.refetch();
        void rates.refetch();
      }}
    />
  );

  if (!periods.data.configured) {
    return (
      <div className="grid gap-3">
        {checklist}
        <p className="text-sm text-muted-foreground" data-testid="payroll-not-configured">
          Finish the setup above to prepare payroll for this branch. No pay is calculated until the policy is saved.
        </p>
      </div>
    );
  }

  const options = periods.data.periods;
  const selected = options.find((p) => periodKeyOf(p) === selection.periodKey) ?? options[1] ?? options[0];
  const key = selected ? periodKeyOf(selected) : '';
  const live = liveRunOf(selected);
  const openRunId = selection.runId ?? live?.id ?? null;
  const createError = create.error && !(create.error instanceof PayrollApiError && (create.error.details as { run_ids?: string[] } | undefined)?.run_ids?.[0]) ? create.error.message : null;

  return (
    <div className="grid gap-4">
      {checklist}

      <Card aria-labelledby="payroll-step-period">
        <CardHeader className="gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 1 of 3</p>
          <CardTitle id="payroll-step-period" className="text-base">
            Choose pay period
          </CardTitle>
          <CardDescription>Payroll covers attendance-based basic pay for the period you choose.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pay periods are available yet.</p>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="grid gap-2 sm:w-80">
                <Label htmlFor="payroll-period">Pay period</Label>
                <Select
                  value={key}
                  onValueChange={(v) => {
                    create.reset();
                    onSelectionChange({ periodKey: v, runId: null });
                  }}
                >
                  <SelectTrigger id="payroll-period" className="min-h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((p) => (
                      <SelectItem key={periodKeyOf(p)} value={periodKeyOf(p)}>
                        {formatPayrollPeriod(p.period_start, p.period_end)} · {periodStatus(p).label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selected && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={periodStatus(selected).variant} data-testid="payroll-period-status">
                    {periodStatus(selected).label}
                  </Badge>
                  {!live && (
                    <Button
                      className="min-h-10 w-full sm:w-auto"
                      disabled={create.isPending}
                      onClick={() =>
                        create.mutate(
                          { period_start: selected.period_start, period_end: selected.period_end },
                          {
                            onSuccess: (run) => onSelectionChange({ periodKey: key, runId: run.id }),
                            onError: (error) => {
                              const ids = error instanceof PayrollApiError ? (error.details as { run_ids?: string[] } | undefined)?.run_ids : undefined;
                              if (ids?.[0]) onSelectionChange({ periodKey: key, runId: ids[0] });
                            },
                          },
                        )
                      }
                    >
                      {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                      Prepare draft payroll
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {createError && (
            <p className="text-sm text-destructive" role="alert">
              The draft was not prepared. {createError} Your pay period is still selected, so you can try again.
            </p>
          )}
          {selected && (selected.runs.length > 1 || (selected.runs.length > 0 && !live)) && (
            <details className="text-sm" data-testid="payroll-history">
              <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Payroll history for this period ({selected.runs.length})
              </summary>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {selected.runs.map((r) => (
                  <RunButton key={r.id} run={r} active={openRunId === r.id} onOpen={() => onSelectionChange({ periodKey: key, runId: r.id })} />
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {openRunId && <PayrollRunView key={openRunId} branchId={branchId} runId={openRunId} onOpenRun={(id) => onSelectionChange({ periodKey: key, runId: id })} />}
    </div>
  );
}

function RunButton({ run, active, onOpen }: { run: PayrollRunSummary; active: boolean; onOpen: () => void }) {
  return (
    <Button variant={active ? 'secondary' : 'outline'} className="h-auto min-h-10 w-full justify-start whitespace-normal py-2 text-left sm:w-auto" onClick={onOpen} aria-pressed={active}>
      <span className="grid">
        <span className="flex flex-wrap items-center gap-2">
          Open {run.revision_number > 1 ? `revision ${run.revision_number}` : 'payroll'}
          <Badge variant={run.status === 'finalized' ? 'active' : run.status === 'draft' ? 'warning' : 'inactive'}>{RUN_STATUS_LABELS[run.status]}</Badge>
          {run.paid_at && <Badge variant="active">Paid</Badge>}
        </span>
        {run.calculated_total && <span className="text-xs text-muted-foreground">Total {formatPeso(run.calculated_total)}</span>}
      </span>
    </Button>
  );
}
