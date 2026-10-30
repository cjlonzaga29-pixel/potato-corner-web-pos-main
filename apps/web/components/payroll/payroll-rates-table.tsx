'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { PayRateEmployeeView, PayRateView, PayRatesResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useVoidPayRate } from '@/hooks/queries/use-payroll';
import { formatPeso } from '@/lib/payroll-format';
import { cn } from '@/lib/utils';
import { PayrollRateDialog } from './payroll-rate-dialog';
import { PayrollReasonDialog } from './payroll-reason-dialog';

interface Props {
  branchId: string;
  data: PayRatesResponse;
}

/**
 * Hourly rates for staff who are, or were, assigned to this branch. Former
 * staff are listed separately: their past time here is still paid with this
 * branch's rate, but nothing about their other branches is shown.
 */
export function PayrollRatesTable({ branchId, data }: Props) {
  const [adding, setAdding] = useState<PayRateEmployeeView | null>(null);
  const [voiding, setVoiding] = useState<{ employee: PayRateEmployeeView; rate: PayRateView } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const voidRate = useVoidPayRate(branchId);
  const groups = [
    { title: 'Current staff', rows: data.employees.filter((e) => e.assignment === 'current') },
    { title: 'Former staff of this branch', rows: data.employees.filter((e) => e.assignment === 'former') },
  ].filter((g) => g.rows.length > 0);

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="text-base">Hourly rates</CardTitle>
        <CardDescription>
          Effective-dated. A new rate never changes earlier earnings. Staff without a rate block finalization — there is no zero-rate default.
          {data.today ? ` Rates shown are in effect on ${data.today}.` : ' Save the payroll policy to see which rate is in effect today.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {data.employees.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground sm:px-0">No staff have been assigned to this branch.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="hidden sm:table-cell">Rate in effect</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.title}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={3} className="py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.title}
                    </TableCell>
                  </TableRow>
                  {group.rows.map((employee) => {
                    const open = expanded[employee.employee_id] ?? false;
                    return (
                      <Fragment key={employee.employee_id}>
                        <TableRow>
                          <TableCell className="align-top">
                            <div className="break-words font-medium">{employee.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {employee.employee_code ?? 'No code'}
                              {!employee.employee_active && ' · inactive'}
                            </div>
                            <div className="mt-1 sm:hidden">
                              <RateCell employee={employee} />
                            </div>
                          </TableCell>
                          <TableCell className="hidden align-top sm:table-cell">
                            <RateCell employee={employee} />
                          </TableCell>
                          <TableCell className="text-right align-top">
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button size="sm" variant="outline" className="min-h-10" onClick={() => setAdding(employee)}>
                                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                                Add rate
                              </Button>
                              {employee.rates.length > 0 && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="min-h-10"
                                  aria-expanded={open}
                                  aria-controls={`rate-history-${employee.employee_id}`}
                                  onClick={() => setExpanded((prev) => ({ ...prev, [employee.employee_id]: !open }))}
                                >
                                  History
                                  <ChevronDown className={cn('ml-1 h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow id={`rate-history-${employee.employee_id}`}>
                            <TableCell colSpan={3} className="bg-muted/20">
                              <ul className="grid gap-2">
                                {employee.rates.map((rate) => (
                                  <li key={rate.id} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2 text-sm', rate.voided_at && 'opacity-60')}>
                                    <div className="min-w-0">
                                      <span className={cn('font-medium', rate.voided_at && 'line-through')}>{formatPeso(rate.hourly_rate)}/h</span>{' '}
                                      from {rate.effective_from}
                                      <div className="break-words text-xs text-muted-foreground">
                                        {rate.reason} — {rate.created_by_name}
                                        {rate.voided_at && ` · Voided: ${rate.void_reason ?? ''}`}
                                      </div>
                                    </div>
                                    {!rate.voided_at && (
                                      <Button size="sm" variant="ghost" className="min-h-10 text-destructive" onClick={() => setVoiding({ employee, rate })}>
                                        Void
                                      </Button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <PayrollRateDialog key={adding?.employee_id ?? 'none'} branchId={branchId} employee={adding} today={data.today} onOpenChange={(open) => !open && setAdding(null)} />
      <PayrollReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => !open && setVoiding(null)}
        title="Void this rate?"
        description={voiding ? `${formatPeso(voiding.rate.hourly_rate)}/h from ${voiding.rate.effective_from} for ${voiding.employee.name}. It stays in the history, marked void. Finalized payroll is not affected.` : ''}
        confirmLabel="Void rate"
        destructive
        isPending={voidRate.isPending}
        onConfirm={(reason) =>
          voiding &&
          voidRate.mutate({ rateId: voiding.rate.id, reason, expected_latest_rate_id: voiding.employee.latest_rate_id }, { onSuccess: () => setVoiding(null) })
        }
      />
    </Card>
  );
}

function RateCell({ employee }: { employee: PayRateEmployeeView }) {
  if (!employee.current_rate) {
    return <Badge variant="warning">No rate</Badge>;
  }
  return (
    <div>
      <span className="font-medium">{formatPeso(employee.current_rate.hourly_rate)}/h</span>
      <span className="block text-xs text-muted-foreground">
        since {employee.current_rate.effective_from} · ≈ ₱{employee.current_rate.per_minute_display}/min
      </span>
    </div>
  );
}
