'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { PayrollEmployeeResult, PayrollIssue, PayrollShiftDetail } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useVoidPayrollAdjustment } from '@/hooks/queries/use-payroll';
import { ADJUSTMENT_CATEGORY_LABELS, formatPayrollDuration, formatPayrollTime, formatPeso } from '@/lib/payroll-format';
import { cn } from '@/lib/utils';
import { PayrollAdjustmentDialog } from './payroll-adjustment-dialog';
import { PayrollReasonDialog } from './payroll-reason-dialog';

interface Props {
  branchId: string;
  runId: string;
  employee: PayrollEmployeeResult;
  issues: PayrollIssue[];
  timeZone: string | undefined;
  editable: boolean;
}

const BREAK_SOURCE_LABEL = { intervals: 'Recorded break times', legacy_total: 'Legacy break total (no recorded times)', none: 'No breaks' } as const;

/** One employee's shifts, breaks and their treatment, payable time, rates and adjustments — each figure shown separately. */
export function PayrollEmployeeDrilldown({ branchId, runId, employee, issues, timeZone, editable }: Props) {
  const [adding, setAdding] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const voidAdjustment = useVoidPayrollAdjustment(branchId, runId);
  const employeeIssues = issues.filter((i) => i.employee_id === employee.employee_id);

  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
        <Stat label="Payable time" value={formatPayrollDuration(employee.payable_ms)} />
        <Stat label="Basic pay" value={formatPeso(employee.basic_pay)} />
        <Stat label="Earnings adjustments" value={formatPeso(employee.earnings_adjustments)} />
        <Stat label="Deductions" value={formatPeso(employee.deductions)} />
        <Stat label="Calculated total" value={formatPeso(employee.calculated_total)} strong />
      </dl>
      {employee.previous_total !== null && (
        <p className="text-sm text-muted-foreground">Previously finalized total for this period: {formatPeso(employee.previous_total)}</p>
      )}

      <section aria-label="Rate breakdown">
        <h4 className="mb-1 text-sm font-semibold">Rate breakdown</h4>
        {employee.rate_lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No paid time at a configured rate.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {employee.rate_lines.map((line) => (
              <li key={line.rate_id} className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/40 px-3 py-2">
                <span>
                  {formatPayrollDuration(line.payable_ms)} × {formatPeso(line.hourly_rate)}/h <span className="text-muted-foreground">(rate from {line.effective_from})</span>
                </span>
                <span className="font-medium">{formatPeso(line.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Daily attendance">
        <h4 className="mb-2 text-sm font-semibold">Daily attendance</h4>
        <div className="grid gap-2">
          {employee.shifts.map((shift) => (
            <ShiftCard key={shift.attendance_record_id} shift={shift} timeZone={timeZone} />
          ))}
        </div>
      </section>

      <section aria-label="Adjustments">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">Adjustments</h4>
          {editable && (
            <Button size="sm" variant="outline" className="min-h-10" onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              Add adjustment
            </Button>
          )}
        </div>
        {employee.adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="grid gap-2">
            {employee.adjustments.map((a) => (
              <li key={a.id} className={cn('flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm', a.voided_at && 'opacity-60')}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={a.kind === 'earning' ? 'active' : 'critical'}>{a.kind === 'earning' ? 'Earning' : 'Deduction'}</Badge>
                    <span className="font-medium">{ADJUSTMENT_CATEGORY_LABELS[a.category] ?? a.category}</span>
                    <span className={cn('font-medium', a.voided_at && 'line-through')}>
                      {a.kind === 'deduction' ? '−' : '+'}
                      {formatPeso(a.amount)}
                    </span>
                    {a.copied_from_id && <Badge variant="outline">Copied from previous version</Badge>}
                    {a.voided_at && <Badge variant="inactive">Voided</Badge>}
                  </div>
                  <p className="mt-1 break-words text-muted-foreground">
                    {a.reason}
                    {a.documentation_ref && ` · Ref: ${a.documentation_ref}`} · {a.created_by_name}
                    {a.voided_at && ` · Void reason: ${a.void_reason ?? ''}`}
                  </p>
                </div>
                {editable && !a.voided_at && (
                  <Button size="sm" variant="ghost" className="min-h-10 text-destructive" onClick={() => setVoidingId(a.id)}>
                    Void
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {employeeIssues.length > 0 && (
        <section aria-label="Issues for this employee">
          <h4 className="mb-1 text-sm font-semibold">Issues</h4>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {employeeIssues.map((i) => (
              <li key={i.key} className="break-words">
                <span className="font-medium">{i.code.replace(/_/g, ' ').toLowerCase()}</span>: {i.message}
                {i.resolution && <span className="text-muted-foreground"> — resolved: “{i.resolution.note}”</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editable && (
        <PayrollAdjustmentDialog
          key={adding ? 'open' : 'closed'}
          branchId={branchId}
          runId={runId}
          employee={adding ? { id: employee.employee_id, name: employee.name } : null}
          onOpenChange={(open) => setAdding(open)}
        />
      )}
      <PayrollReasonDialog
        open={voidingId !== null}
        onOpenChange={(open) => !open && setVoidingId(null)}
        title="Void this adjustment?"
        description="It stays on the record, marked void, and no longer counts toward the total."
        confirmLabel="Void adjustment"
        destructive
        isPending={voidAdjustment.isPending}
        onConfirm={(reason) => voidingId && voidAdjustment.mutate({ adjustmentId: voidingId, reason }, { onSuccess: () => setVoidingId(null) })}
      />
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}

function ShiftCard({ shift, timeZone }: { shift: PayrollShiftDetail; timeZone: string | undefined }) {
  return (
    <article className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="font-medium">{shift.business_date}</h5>
        <span className="tabular-nums">
          Payable <span className="font-semibold">{formatPayrollDuration(shift.payable_ms)}</span>
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Clock in → out</dt>
          <dd>
            {formatPayrollTime(shift.clock_in, timeZone)} → {shift.clock_out ? formatPayrollTime(shift.clock_out, timeZone) : <Badge variant="critical">Still clocked in</Badge>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Shift span</dt>
          <dd>{formatPayrollDuration(shift.span_ms)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Breaks ({BREAK_SOURCE_LABEL[shift.break_source]})</dt>
          <dd>
            {shift.breaks.length === 0
              ? '—'
              : shift.breaks.map((b, i) => (
                  <span key={i} className="block">
                    {b.source === 'legacy_total' ? `${b.minutes} min total` : `${formatPayrollTime(b.started_at, timeZone)}–${b.ended_at ? formatPayrollTime(b.ended_at, timeZone).slice(-5) : 'open'}`}
                    <span className="text-muted-foreground">
                      {' '}
                      · paid {b.paid_minutes} / unpaid {b.unpaid_minutes} min
                    </span>
                  </span>
                ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Rate applied</dt>
          <dd>
            {shift.segments.length === 0
              ? '—'
              : shift.segments.map((s, i) => (
                  <span key={i} className="block">
                    {s.business_date}: {formatPayrollDuration(s.payable_ms)} @ {s.hourly_rate ? `${formatPeso(s.hourly_rate)}/h` : <Badge variant="critical">No rate</Badge>}
                  </span>
                ))}
          </dd>
        </div>
      </dl>
      {(shift.corrected || shift.note || shift.issue_codes.length > 0) && (
        <p className="mt-2 break-words text-xs text-muted-foreground">
          {shift.corrected && `Corrected by ${shift.corrected.by ?? 'a supervisor'}${shift.corrected.reason ? ` — “${shift.corrected.reason}”` : ''}. `}
          {shift.note && `${shift.note} `}
          {shift.issue_codes.length > 0 && `Flags: ${shift.issue_codes.map((c) => c.replace(/_/g, ' ').toLowerCase()).join(', ')}`}
        </p>
      )}
    </article>
  );
}
