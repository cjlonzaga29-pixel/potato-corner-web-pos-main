'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PayrollRunSummary } from '@potato-corner/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PayrollApiError, useCreatePayrollRun, usePayRates, usePayrollPeriods } from '@/hooks/queries/use-payroll';
import { RUN_STATUS_LABELS, formatPeso } from '@/lib/payroll-format';
import { PayrollRunView } from './payroll-run-view';

interface Props {
  branchId: string;
  onConfigure: () => void;
}

/** select period → generate draft → review → finalize → export. */
export function PayrollRunsPanel({ branchId, onConfigure }: Props) {
  const periods = usePayrollPeriods(branchId);
  const rates = usePayRates(branchId);
  const create = useCreatePayrollRun(branchId);
  const [periodKey, setPeriodKey] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    setPeriodKey(null);
    setRunId(null);
  }, [branchId]);

  if (periods.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading pay periods…
      </p>
    );
  }
  if (periods.isError || !periods.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load payroll</AlertTitle>
        <AlertDescription>{periods.error?.message}</AlertDescription>
      </Alert>
    );
  }
  if (!periods.data.configured) {
    return (
      <Alert>
        <AlertTitle>Payroll is not configured for this branch</AlertTitle>
        <AlertDescription className="grid gap-3">
          <span>Set the business timezone, pay period and break treatment first. Nothing is assumed.</span>
          <span>After that, add an hourly rate for each employee. Regular work hours in Settings are attendance only; they do not set pay.</span>
          <Button variant="outline" className="w-full sm:w-fit" onClick={onConfigure}>
            Open Payroll Settings
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const options = periods.data.periods;
  const selected = options.find((p) => `${p.period_start}|${p.period_end}` === periodKey) ?? options[1] ?? options[0];
  const key = selected ? `${selected.period_start}|${selected.period_end}` : '';
  const live = selected?.runs.find((r) => r.status === 'draft' || r.status === 'finalized');
  const missingRates = rates.data?.employees.filter((e) => e.assignment === 'current' && e.employee_active && e.current_rate === null) ?? [];

  return (
    <div className="grid gap-4">
      {missingRates.length > 0 && (
        <Alert data-testid="payroll-missing-rates">
          <AlertTitle>
            {missingRates.length} current employee{missingRates.length === 1 ? ' has' : 's have'} no hourly rate in effect
          </AlertTitle>
          <AlertDescription className="grid gap-3">
            <span className="break-words">{missingRates.map((e) => e.name).join(', ')}. Payroll can&apos;t be finalized for a period they worked until a rate covers it; there is no default rate.</span>
            <Button variant="outline" className="w-full sm:w-fit" onClick={onConfigure}>
              Add rates in Payroll Settings
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Pay period</CardTitle>
          <CardDescription>Shifts belong to the period of their clock-in business date.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="payroll-period">Period</Label>
            <Select
              value={key}
              onValueChange={(v) => {
                setPeriodKey(v);
                setRunId(null);
              }}
            >
              <SelectTrigger id="payroll-period" className="min-h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((p) => (
                  <SelectItem key={`${p.period_start}|${p.period_end}`} value={`${p.period_start}|${p.period_end}`}>
                    {p.label}
                    {p.runs.some((r) => r.status === 'finalized') ? ' · finalized' : p.runs.some((r) => r.status === 'draft') ? ' · draft' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {!live && (
                <Button
                  className="w-full sm:w-auto"
                  disabled={create.isPending}
                  onClick={() =>
                    create.mutate(
                      { period_start: selected.period_start, period_end: selected.period_end },
                      {
                        onSuccess: (run) => setRunId(run.id),
                        onError: (error) => {
                          const ids = error instanceof PayrollApiError ? (error.details as { run_ids?: string[] } | undefined)?.run_ids : undefined;
                          if (ids?.[0]) setRunId(ids[0]);
                        },
                      },
                    )
                  }
                >
                  {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  Generate draft
                </Button>
              )}
              {selected.runs.map((r) => (
                <RunButton key={r.id} run={r} active={runId === r.id} onOpen={() => setRunId(r.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {runId && <PayrollRunView branchId={branchId} runId={runId} onOpenRun={setRunId} />}
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
