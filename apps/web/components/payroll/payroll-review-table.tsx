'use client';

import type { PayrollEmployeeResult, PayrollRunDetail, PayrollRateLine } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPayrollDate, formatPayrollDuration, formatPeso } from '@/lib/payroll-format';
import { cn } from '@/lib/utils';

interface Props {
  detail: PayrollRunDetail;
  selectedId: string | null;
  onToggle: (employeeId: string) => void;
  filtered: boolean;
}

/**
 * POS-PERF-P66 — the one employee list on the payroll screen. Rates come from
 * the run itself (the rate in effect on each worked day of this period), never
 * from today's rate. A compact table on desktop, readable cards on phones.
 */
export function PayrollReviewTable({ detail, selectedId, onToggle, filtered }: Props) {
  const missingRateKeys = new Set(detail.issues.filter((i) => i.code === 'RATE_MISSING').map((i) => i.key));
  const rows = detail.employees.map((e) => ({ employee: e, missingRate: e.issue_keys.some((k) => missingRateKeys.has(k)) }));

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No staff attendance in this period.</p>;

  return (
    <>
      <div className="hidden md:block" data-testid="payroll-review-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Recorded hours</TableHead>
              <TableHead>Rate for this period</TableHead>
              <TableHead className="text-right">Basic pay</TableHead>
              <TableHead className="text-right">Adjustments</TableHead>
              <TableHead className="text-right">{detail.total_label}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ employee: e, missingRate }) => (
              <TableRow key={e.employee_id} data-state={selectedId === e.employee_id ? 'selected' : undefined}>
                <TableCell className="max-w-[14rem] align-top">
                  <div className="break-words font-medium">{e.name}</div>
                  {e.employee_code && <div className="text-xs text-muted-foreground">{e.employee_code}</div>}
                  <Flags employee={e} />
                </TableCell>
                <TableCell className="align-top tabular-nums">{formatPayrollDuration(e.payable_ms)}</TableCell>
                <TableCell className="align-top text-xs">
                  <RateLines lines={e.rate_lines} missingRate={missingRate} />
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  <Pay employee={e} missingRate={missingRate} />
                </TableCell>
                <TableCell className="text-right align-top text-xs tabular-nums">
                  <Adjustments employee={e} />
                </TableCell>
                <TableCell className="text-right align-top font-semibold tabular-nums">{formatPeso(e.calculated_total)}</TableCell>
                <TableCell className="align-top">
                  <DetailsButton employee={e} open={selectedId === e.employee_id} onToggle={onToggle} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">Total{filtered ? ' (filtered)' : ''}</TableCell>
              <TableCell className="tabular-nums">{formatPayrollDuration(detail.totals.payable_ms)}</TableCell>
              <TableCell />
              <TableCell className="text-right tabular-nums">{formatPeso(detail.totals.basic_pay)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                +{formatPeso(detail.totals.earnings_adjustments)} / −{formatPeso(detail.totals.deductions)}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{formatPeso(detail.totals.calculated_total)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <ul className="grid gap-3 md:hidden" data-testid="payroll-review-cards">
        {rows.map(({ employee: e, missingRate }) => (
          <li key={e.employee_id} className={cn('rounded-lg border p-3 text-sm', selectedId === e.employee_id && 'border-primary')}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-words font-medium">{e.name}</div>
                {e.employee_code && <div className="text-xs text-muted-foreground">{e.employee_code}</div>}
                <Flags employee={e} />
              </div>
              <div className="text-right">
                <div className="text-xs text-muted-foreground">{detail.total_label}</div>
                <div className="font-semibold tabular-nums">{formatPeso(e.calculated_total)}</div>
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
              <div>
                <dt className="text-xs text-muted-foreground">Recorded hours</dt>
                <dd className="tabular-nums">{formatPayrollDuration(e.payable_ms)}</dd>
              </div>
              <div className="text-right">
                <dt className="text-xs text-muted-foreground">Basic pay</dt>
                <dd className="tabular-nums">
                  <Pay employee={e} missingRate={missingRate} />
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Rate for this period</dt>
                <dd className="text-xs">
                  <RateLines lines={e.rate_lines} missingRate={missingRate} />
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Adjustments</dt>
                <dd className="text-xs tabular-nums">
                  <Adjustments employee={e} />
                </dd>
              </div>
            </dl>
            <div className="mt-2">
              <DetailsButton employee={e} open={selectedId === e.employee_id} onToggle={onToggle} className="w-full" />
            </div>
          </li>
        ))}
        <li className="flex justify-between rounded-lg bg-muted/40 p-3 text-sm font-semibold">
          <span>Total{filtered ? ' (filtered)' : ''}</span>
          <span className="tabular-nums">{formatPeso(detail.totals.calculated_total)}</span>
        </li>
      </ul>
    </>
  );
}

/** The period's own rate lines. Several lines mean the rate changed inside this period. */
function RateLines({ lines, missingRate }: { lines: PayrollRateLine[]; missingRate: boolean }) {
  return (
    <div className="grid gap-0.5" data-testid="payroll-rate-lines">
      {lines.map((l) => (
        <div key={l.rate_id}>
          {formatPeso(l.hourly_rate)}/h <span className="text-muted-foreground">from {formatPayrollDate(l.effective_from)} · {formatPayrollDuration(l.payable_ms)}</span>
        </div>
      ))}
      {lines.length > 1 && <p className="text-muted-foreground">The rate changed during this period. Each day is paid at the rate in effect that day.</p>}
      {missingRate && (
        <Badge variant="warning" className="w-fit">
          {lines.length === 0 ? 'No rate for this period' : 'No rate for some days'}
        </Badge>
      )}
      {lines.length === 0 && !missingRate && <span className="text-muted-foreground">—</span>}
    </div>
  );
}

/** Basic pay; time without a rate is never presented as ₱0 pay. */
function Pay({ employee, missingRate }: { employee: PayrollEmployeeResult; missingRate: boolean }) {
  if (missingRate && employee.rate_lines.length === 0) return <span className="text-amber-700 dark:text-amber-400">Needs a rate</span>;
  return (
    <>
      {formatPeso(employee.basic_pay)}
      {missingRate && <span className="block text-xs text-amber-700 dark:text-amber-400">Incomplete — needs a rate</span>}
    </>
  );
}

function Adjustments({ employee }: { employee: PayrollEmployeeResult }) {
  const active = employee.adjustments.filter((a) => !a.voided_at).length;
  if (active === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <>
      +{formatPeso(employee.earnings_adjustments)} / −{formatPeso(employee.deductions)}
    </>
  );
}

function Flags({ employee }: { employee: PayrollEmployeeResult }) {
  if (employee.issue_keys.length === 0) return null;
  return (
    <Badge variant="warning" className="mt-1">
      {employee.issue_keys.length} to check
    </Badge>
  );
}

function DetailsButton({ employee, open, onToggle, className }: { employee: PayrollEmployeeResult; open: boolean; onToggle: (id: string) => void; className?: string }) {
  return (
    <Button size="sm" variant="outline" className={cn('min-h-10', className)} aria-expanded={open} aria-controls="payroll-employee-details" onClick={() => onToggle(employee.employee_id)}>
      {open ? 'Hide details' : 'Details'}
      <span className="sr-only"> for {employee.name}</span>
    </Button>
  );
}
