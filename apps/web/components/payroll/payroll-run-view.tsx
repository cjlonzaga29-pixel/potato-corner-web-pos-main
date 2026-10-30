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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExportButtons } from '@/components/reports/export-buttons';
import { usePayrollExport, usePayrollRun, usePayrollRunAction } from '@/hooks/queries/use-payroll';
import { RUN_STATUS_LABELS, formatPayrollDuration, formatPeso } from '@/lib/payroll-format';
import { PayrollEmployeeDrilldown } from './payroll-employee-drilldown';
import { PayrollFinalizeDialog } from './payroll-finalize-dialog';
import { PayrollIssuesList } from './payroll-issues-list';
import { PayrollReasonDialog } from './payroll-reason-dialog';

interface Props {
  branchId: string;
  runId: string;
  onOpenRun: (runId: string) => void;
}

const ALL = '__all__';

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
  if (query.isError || !detail) {
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
      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">
              {detail.period_start} to {detail.period_end}
            </CardTitle>
            <StatusBadge detail={detail} />
            {detail.revision_number > 1 && <Badge variant="outline">Revision {detail.revision_number}</Badge>}
          </div>
          <CardDescription>
            {isDraft
              ? `Live calculation from current attendance, rates and settings (calculated ${new Date(detail.calculated_at).toLocaleString('en-PH')}). Nothing is final until you finalize.`
              : detail.status === 'discarded'
                ? 'This draft was discarded. It is kept for the record.'
                : `Stored record finalized by ${detail.finalized_by_name ?? '—'} on ${new Date(detail.calculated_at).toLocaleString('en-PH')}. It does not change when attendance, rates or settings change.`}
            {detail.revision_reason && ` Revision reason: “${detail.revision_reason}”.`}
            {detail.paid_at && ` Marked paid by ${detail.paid_by_name ?? '—'} on ${new Date(detail.paid_at).toLocaleString('en-PH')}${detail.paid_reference ? ` (ref ${detail.paid_reference})` : ''}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <AlertTitle>Basic time-based pay — not statutory net pay</AlertTitle>
            <AlertDescription>Not included: {detail.exclusions.join('; ')}.</AlertDescription>
          </Alert>

          {detail.source_changes.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>Attendance changed after finalization</AlertTitle>
              <AlertDescription>
                {detail.source_changes.length} attendance record(s) were corrected or added after this payroll was finalized. These figures are unchanged; use Revise to correct them.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {isDraft && (
              <Button onClick={() => setDialog('finalize')} disabled={!detail.can_finalize} className="w-full sm:w-auto">
                Finalize…
              </Button>
            )}
            <ExportButtons
              onExportCsv={() => exporter.mutate({ format: 'csv', employeeId: employeeFilter })}
              onExportPdf={() => exporter.mutate({ format: 'pdf', employeeId: employeeFilter })}
              isExportingCsv={exporter.isPending && exporter.variables?.format === 'csv'}
              isExportingPdf={exporter.isPending && exporter.variables?.format === 'pdf'}
            />
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
          {isDraft && !detail.can_finalize && (
            <p className="text-sm text-destructive" role="status">
              {detail.blocking_count} item(s) must be resolved before this payroll can be finalized.
            </p>
          )}
          {isDraft && (
            <p className="text-xs text-muted-foreground">
              Exports of a draft are labelled DRAFT on every page.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">Issues</CardTitle>
          <CardDescription>Finalization is blocked until blocking items are fixed and every special-pay item has a resolution note.</CardDescription>
        </CardHeader>
        <CardContent>
          <PayrollIssuesList branchId={branchId} runId={runId} issues={detail.issues} names={names} editable={isDraft} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle className="text-base">Summary</CardTitle>
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="payroll-employee-filter">Employee</Label>
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
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {detail.employees.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground sm:px-0">No staff attendance in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="hidden md:table-cell">Payable time</TableHead>
                  <TableHead className="hidden lg:table-cell">Rate breakdown</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Basic pay</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Earnings adj.</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Deductions</TableHead>
                  <TableHead className="text-right">{detail.total_label}</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Details</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.employees.map((e) => (
                  <TableRow key={e.employee_id} data-state={selected === e.employee_id ? 'selected' : undefined}>
                    <TableCell className="max-w-[14rem] align-top">
                      <div className="break-words font-medium">{e.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {e.employee_code ?? ''}
                        <span className="md:hidden"> · {formatPayrollDuration(e.payable_ms)}</span>
                      </div>
                      {e.issue_keys.length > 0 && <Badge variant="warning" className="mt-1">{e.issue_keys.length} flag(s)</Badge>}
                    </TableCell>
                    <TableCell className="hidden align-top md:table-cell">{formatPayrollDuration(e.payable_ms)}</TableCell>
                    <TableCell className="hidden align-top text-xs lg:table-cell">
                      {e.rate_lines.length === 0 ? '—' : e.rate_lines.map((l) => <div key={l.rate_id}>{formatPayrollDuration(l.payable_ms)} @ {formatPeso(l.hourly_rate)}/h = {formatPeso(l.amount)}</div>)}
                    </TableCell>
                    <TableCell className="hidden text-right align-top tabular-nums md:table-cell">{formatPeso(e.basic_pay)}</TableCell>
                    <TableCell className="hidden text-right align-top tabular-nums lg:table-cell">{formatPeso(e.earnings_adjustments)}</TableCell>
                    <TableCell className="hidden text-right align-top tabular-nums lg:table-cell">{formatPeso(e.deductions)}</TableCell>
                    <TableCell className="text-right align-top font-semibold tabular-nums">{formatPeso(e.calculated_total)}</TableCell>
                    <TableCell className="align-top">
                      <Button size="sm" variant="outline" className="min-h-10" aria-expanded={selected === e.employee_id} onClick={() => setSelected(selected === e.employee_id ? null : e.employee_id)}>
                        Details<span className="sr-only"> for {e.name}</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">Total{employeeFilter ? ' (filtered)' : ''}</TableCell>
                  <TableCell className="hidden md:table-cell">{formatPayrollDuration(detail.totals.payable_ms)}</TableCell>
                  <TableCell className="hidden lg:table-cell" />
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatPeso(detail.totals.basic_pay)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatPeso(detail.totals.earnings_adjustments)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums lg:table-cell">{formatPeso(detail.totals.deductions)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatPeso(detail.totals.calculated_total)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedEmployee && (
        <Card ref={drilldownRef} tabIndex={-1} aria-label={`Payroll details for ${selectedEmployee.name}`} className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CardHeader>
            <CardTitle className="break-words text-base">{selectedEmployee.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <PayrollEmployeeDrilldown branchId={branchId} runId={runId} employee={selectedEmployee} issues={detail.issues} timeZone={timeZone} editable={isDraft} />
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
        onConfirm={(reason) => revise.mutate({ reason }, { onSuccess: (run) => { setDialog(null); onOpenRun(run.id); } })}
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
