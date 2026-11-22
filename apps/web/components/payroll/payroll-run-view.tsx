'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PayrollRunDetail } from '@potato-corner/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExportButtons } from '@/components/reports/export-buttons';
import { usePayrollExport, usePayrollRun, usePayrollRunAction } from '@/hooks/queries/use-payroll';
import { RUN_STATUS_LABELS, formatPayrollDateTime, formatPayrollPeriod } from '@/lib/payroll-format';
import { PayrollEmployeeDrilldown } from './payroll-employee-drilldown';
import { PayrollFinalizeDialog } from './payroll-finalize-dialog';
import { PayrollIssuesList } from './payroll-issues-list';
import { PayrollReasonDialog } from './payroll-reason-dialog';
import { PayrollReviewTable } from './payroll-review-table';

interface Props {
  branchId: string;
  runId: string;
  onOpenRun: (runId: string) => void;
}

const ALL = '__all__';

/**
 * POS-PERF-P66 — step 2 (review) and step 3 (finalize) of the payroll flow.
 * Figures, checks and finalization are the server's, unchanged: a draft is a
 * live calculation, a finalized run is its stored snapshot and is read-only.
 */
export function PayrollRunView({ branchId, runId, onOpenRun }: Props) {
  const [employeeFilter, setEmployeeFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'finalize' | 'discard' | 'revise' | 'paid' | null>(null);
  const drilldownRef = useRef<HTMLDivElement>(null);
  // The unfiltered run supplies the employee list for the filter even while one employee is shown.
  const full = usePayrollRun(branchId, runId, null);
  const filtered = usePayrollRun(branchId, runId, employeeFilter);
  const query = employeeFilter ? filtered : full;
  const detail = query.data;
  const exporter = usePayrollExport(branchId, runId);
  const discard = usePayrollRunAction(branchId, runId, 'discard', 'Draft discarded');
  const revise = usePayrollRunAction(branchId, runId, 'revise', 'Revision draft created');
  const markPaid = usePayrollRunAction(branchId, runId, 'mark-paid', 'Marked as paid');

  useEffect(() => {
    setEmployeeFilter(null);
    setSelected(null);
  }, [runId]);
  useEffect(() => {
    if (selected) drilldownRef.current?.focus();
  }, [selected]);

  const names = useMemo(() => new Map((full.data?.employees ?? []).map((e) => [e.employee_id, e.name])), [full.data]);

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Calculating payroll…
      </div>
    );
  }
  // Never render a run that belongs to another branch (e.g. a cached response while the branch is switching).
  if (query.isError || !detail || detail.branch_id !== branchId) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load this payroll</AlertTitle>
        <AlertDescription>{query.error?.message ?? 'Unknown error'}</AlertDescription>
      </Alert>
    );
  }

  const isDraft = detail.status === 'draft';
  const selectedEmployee = detail.employees.find((e) => e.employee_id === selected) ?? null;
  const timeZone = detail.policy?.timezone;

  return (
    <div className="grid gap-4">
      <Card aria-labelledby="payroll-step-review">
        <CardHeader className="gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 2 of 3</p>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id="payroll-step-review" className="text-base">
              Review payroll · {formatPayrollPeriod(detail.period_start, detail.period_end)}
            </CardTitle>
            <StatusBadge detail={detail} />
            {detail.revision_number > 1 && <Badge variant="outline">Revision {detail.revision_number}</Badge>}
          </div>
          <CardDescription>
            {isDraft
              ? `Draft calculated ${formatPayrollDateTime(detail.calculated_at, timeZone)} from current attendance, rates and settings. Nothing is final until you finalize.`
              : detail.status === 'discarded'
                ? 'This draft was discarded. It is kept for the record.'
                : `Read-only. Finalized by ${detail.finalized_by_name ?? '—'} on ${formatPayrollDateTime(detail.calculated_at, timeZone)}. It does not change when attendance, rates or settings change.`}
            {detail.revision_reason && ` Revision reason: “${detail.revision_reason}”.`}
            {detail.paid_at && ` Marked paid by ${detail.paid_by_name ?? '—'} on ${formatPayrollDateTime(detail.paid_at, timeZone)}${detail.paid_reference ? ` (ref ${detail.paid_reference})` : ''}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <details className="rounded-md border p-3 text-sm" data-testid="payroll-exclusions">
            <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Basic time-based pay — not statutory net pay</summary>
            <p className="mt-2 text-muted-foreground">
              Pay is worked out from recorded attendance only. It is not a payout, and these are not included: {detail.exclusions.join('; ')}.
            </p>
          </details>

          {detail.source_changes.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>Attendance changed after finalization</AlertTitle>
              <AlertDescription>
                {detail.source_changes.length} attendance record(s) were corrected or added after this payroll was finalized. These figures are unchanged; use Revise to correct them.
              </AlertDescription>
            </Alert>
          )}

          {detail.issues.length > 0 && (
            <section aria-labelledby="payroll-issues-heading" className="grid gap-2">
              <h3 id="payroll-issues-heading" className="text-sm font-semibold">
                Items to check
              </h3>
              <PayrollIssuesList branchId={branchId} runId={runId} issues={detail.issues} names={names} editable={isDraft} />
            </section>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
            <div className="grid gap-1 sm:w-64">
              <Label htmlFor="payroll-employee-filter">Show</Label>
              <Select
                value={employeeFilter ?? ALL}
                onValueChange={(v) => {
                  setEmployeeFilter(v === ALL ? null : v);
                  setSelected(v === ALL ? null : v);
                }}
              >
                <SelectTrigger id="payroll-employee-filter" className="min-h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All employees</SelectItem>
                  {(full.data?.employees ?? []).map((e) => (
                    <SelectItem key={e.employee_id} value={e.employee_id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ExportButtons
              onExportCsv={() => exporter.mutate({ format: 'csv', employeeId: employeeFilter })}
              onExportPdf={() => exporter.mutate({ format: 'pdf', employeeId: employeeFilter })}
              isExportingCsv={exporter.isPending && exporter.variables?.format === 'csv'}
              isExportingPdf={exporter.isPending && exporter.variables?.format === 'pdf'}
            />
          </div>
          {isDraft && <p className="-mt-2 text-xs text-muted-foreground">Exports of a draft are labelled DRAFT on every page.</p>}

          <PayrollReviewTable detail={detail} selectedId={selected} onToggle={(id) => setSelected(selected === id ? null : id)} filtered={employeeFilter !== null} />

          {selectedEmployee && (
            <div
              id="payroll-employee-details"
              ref={drilldownRef}
              tabIndex={-1}
              role="region"
              aria-label={`Payroll details for ${selectedEmployee.name}`}
              className="rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4"
            >
              <h3 className="mb-3 break-words text-sm font-semibold">Calculation details · {selectedEmployee.name}</h3>
              <PayrollEmployeeDrilldown branchId={branchId} runId={runId} employee={selectedEmployee} issues={detail.issues} timeZone={timeZone} editable={isDraft} />
            </div>
          )}

          <details className="text-sm text-muted-foreground" data-testid="payroll-advanced">
            <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">How payroll is worked out</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Shifts belong to the period of their clock-in business date.</li>
              <li>Each worked day uses the hourly rate in effect on that day, so a rate change inside the period shows as more than one rate.</li>
              <li>Recorded break times are paid or unpaid according to the branch&apos;s break setting. Corrected attendance is used as corrected.</li>
              <li>Regular work hours in Settings are attendance only; they do not set pay.</li>
              <li>A draft follows current attendance, rates and settings. A finalized payroll never changes on its own; corrections need a revision.</li>
            </ul>
          </details>

          {(isDraft || detail.status === 'finalized' || (detail.status === 'superseded' && detail.superseded_by_id)) && (
            <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap">
              {isDraft && (
                <Button variant="ghost" className="w-full text-destructive sm:w-auto" onClick={() => setDialog('discard')}>
                  Discard draft
                </Button>
              )}
              {detail.status === 'finalized' && (
                <>
                  <Button variant="outline" className="w-full sm:w-auto" onClick={() => setDialog('revise')}>
                    Revise…
                  </Button>
                  {!detail.paid_at && (
                    <Button variant="outline" className="w-full sm:w-auto" onClick={() => setDialog('paid')}>
                      Mark as paid…
                    </Button>
                  )}
                </>
              )}
              {detail.status === 'superseded' && detail.superseded_by_id && (
                <Button variant="outline" className="w-full sm:w-auto" onClick={() => onOpenRun(detail.superseded_by_id as string)}>
                  Open the revision
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {isDraft && (
        <Card aria-labelledby="payroll-step-finalize">
          <CardHeader className="gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step 3 of 3</p>
            <CardTitle id="payroll-step-finalize" className="text-base">
              Finalize payroll
            </CardTitle>
            <CardDescription>
              {detail.can_finalize
                ? 'All required checks pass. Finalizing stores these figures and locks them; you confirm in the next step.'
                : 'Finalizing is available once the items to check above are resolved.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {!detail.can_finalize && (
              <p className="text-sm text-destructive" role="status">
                {detail.blocking_count} item(s) must be resolved before this payroll can be finalized.
              </p>
            )}
            <div>
              <Button onClick={() => setDialog('finalize')} disabled={!detail.can_finalize} className="min-h-10 w-full sm:w-auto">
                Finalize payroll…
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isDraft && <PayrollFinalizeDialog branchId={branchId} detail={detail} open={dialog === 'finalize'} onOpenChange={(open) => setDialog(open ? 'finalize' : null)} />}
      <PayrollReasonDialog
        open={dialog === 'discard'}
        onOpenChange={(open) => setDialog(open ? 'discard' : null)}
        title="Discard this draft?"
        description="The draft and its adjustments stay on record as discarded. You can generate a new draft for this period afterwards."
        confirmLabel="Discard draft"
        destructive
        isPending={discard.isPending}
        onConfirm={(reason) => discard.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />
      <PayrollReasonDialog
        open={dialog === 'revise'}
        onOpenChange={(open) => setDialog(open ? 'revise' : null)}
        title="Start a revision"
        description="Creates a new draft for this period from current attendance and rates, with this payroll's adjustments copied. This finalized payroll stays in force until the revision is finalized, then it is kept as superseded."
        confirmLabel="Create revision draft"
        isPending={revise.isPending}
        onConfirm={(reason) =>
          revise.mutate(
            { reason },
            {
              onSuccess: (run) => {
                setDialog(null);
                onOpenRun(run.id);
              },
            },
          )
        }
      />
      <PayrollReasonDialog
        open={dialog === 'paid'}
        onOpenChange={(open) => setDialog(open ? 'paid' : null)}
        title="Mark as paid"
        description="Records that this payroll was paid outside the system. No money is moved."
        fieldLabel="Payment reference (optional)"
        required={false}
        confirmLabel="Mark as paid"
        isPending={markPaid.isPending}
        onConfirm={(ref) => markPaid.mutate({ paid_reference: ref || undefined }, { onSuccess: () => setDialog(null) })}
      />
    </div>
  );
}

function StatusBadge({ detail }: { detail: PayrollRunDetail }) {
  if (detail.status === 'finalized') {
    return (
      <>
        <Badge variant="active">{RUN_STATUS_LABELS.finalized}</Badge>
        <Badge variant={detail.paid_at ? 'active' : 'outline'}>{detail.paid_at ? 'Paid' : 'Not marked paid'}</Badge>
      </>
    );
  }
  if (detail.status === 'draft') return <Badge variant="warning">{RUN_STATUS_LABELS.draft}</Badge>;
  return <Badge variant="inactive">{RUN_STATUS_LABELS[detail.status]}</Badge>;
}
