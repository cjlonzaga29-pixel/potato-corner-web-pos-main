'use client';

import Link from 'next/link';
import type { ExpenseSummaryGroup } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useExpenseSummary } from '@/hooks/queries/use-expenses';
import { expenseLedgerHref } from '@/lib/expense-ledger-link';
import { formatCurrency } from '@/lib/utils';

interface ExpenseBreakdownCardProps {
  title: string;
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** The ledger page these lines open, or undefined where none should. */
  ledgerPath?: string;
  /** Wait for a branch instead of reading every branch in scope. */
  enabled?: boolean;
}

function groupKeyFilters(group: ExpenseSummaryGroup) {
  return group.expense_type_id ? { expenseTypeId: group.expense_type_id } : { category: group.category ?? undefined };
}

/** POS-PERF-P60 — a total and its breakdown by type, from one grouped query over the ledger's own filters. */
export function ExpenseBreakdownCard({ title, branchId, dateFrom, dateTo, ledgerPath, enabled = true }: ExpenseBreakdownCardProps) {
  const summary = useExpenseSummary({ branch_id: branchId, date_from: dateFrom, date_to: dateTo }, { enabled });
  const link = (group?: ExpenseSummaryGroup) => ledgerPath && expenseLedgerHref(ledgerPath, { branchId, dateFrom, dateTo, ...(group && groupKeyFilters(group)) });
  const allHref = link();

  return (
    <Card data-testid="expense-breakdown-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {allHref && (
          <Button variant="link" size="sm" asChild className="h-auto p-0">
            <Link href={allHref}>View ledger</Link>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {summary.isError ? (
          <p className="text-sm text-muted-foreground" role="alert">
            This breakdown is unavailable.{' '}
            <button type="button" className="underline underline-offset-2" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </p>
        ) : summary.isLoading || !summary.data ? (
          <Skeleton className="h-16 w-full" />
        ) : summary.data.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No expenses recorded for this period.</p>
        ) : (
          <>
            <p className="font-semibold tabular-nums" data-testid="expense-breakdown-total">
              {formatCurrency(summary.data.total_amount)}{' '}
              <span className="text-sm font-normal text-muted-foreground">
                across {summary.data.total} {summary.data.total === 1 ? 'record' : 'records'}
              </span>
            </p>
            <ul className="mt-3 max-h-60 divide-y overflow-y-auto">
              {summary.data.groups.map((group) => {
                const href = link(group);
                const label = (
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    <span className="[overflow-wrap:anywhere]">{group.name}</span>
                    {group.is_active === false && <Badge variant="inactive">Deactivated</Badge>}
                  </span>
                );
                return (
                  <li key={group.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                    {href ? (
                      <Link href={href} className="min-w-0 underline-offset-2 hover:underline">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                    <span className="shrink-0 text-right tabular-nums">
                      {formatCurrency(group.total_amount)} <span className="text-xs text-muted-foreground">· {group.count}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
