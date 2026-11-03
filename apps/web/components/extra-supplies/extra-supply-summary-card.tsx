'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useExtraSupplySummary } from '@/hooks/queries/use-extra-supplies';
import { formatCurrency } from '@/lib/utils';

interface ExtraSupplySummaryCardProps {
  title: string;
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** The history page these figures open. */
  historyPath: string;
  enabled?: boolean;
}

/**
 * POS-PERF-P61 — the same aggregate on every dashboard and report, from the issue
 * lines themselves. No ledger of its own. Costs carry their source, and an unknown
 * cost is counted rather than shown as zero.
 */
export function ExtraSupplySummaryCard({ title, branchId, dateFrom, dateTo, historyPath, enabled = true }: ExtraSupplySummaryCardProps) {
  const summary = useExtraSupplySummary({ branchId, dateFrom, dateTo }, { enabled });
  const params = new URLSearchParams();
  if (branchId) params.set('branch_id', branchId);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  const href = params.size > 0 ? `${historyPath}?${params.toString()}` : historyPath;
  const data = summary.data;

  return (
    <Card data-testid="extra-supply-summary-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button variant="link" size="sm" asChild className="h-auto p-0">
          <Link href={href}>View history</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {summary.isError ? (
          <p className="text-sm text-muted-foreground" role="alert">
            These figures are unavailable.{' '}
            <button type="button" className="underline underline-offset-2" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </p>
        ) : summary.isLoading || !data ? (
          <Skeleton className="h-16 w-full" />
        ) : data.issue_count === 0 ? (
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">No extra supplies issued in this period.</p>
            {data.product_sales_total !== null && <p className="tabular-nums">Product sales: {formatCurrency(data.product_sales_total)}</p>}
          </div>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Issued free</dt>
              <dd className="font-semibold tabular-nums" data-testid="summary-units-free">{data.units_free} units</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Issued paid</dt>
              <dd className="font-semibold tabular-nums" data-testid="summary-units-paid">{data.units_paid} units</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Supply collections</dt>
              <dd className="font-semibold tabular-nums" data-testid="summary-collected">{formatCurrency(data.amount_collected)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Cost of supplies issued</dt>
              <dd className="font-semibold tabular-nums" data-testid="summary-cost">{formatCurrency(data.inventory_cost)}</dd>
              <dd className="text-xs text-muted-foreground">
                From inventory cost.
                {data.configured_cost > 0 && ` Plus ${formatCurrency(data.configured_cost)} stated on cards.`}
                {data.unknown_cost_lines > 0 && ` ${data.unknown_cost_lines} ${data.unknown_cost_lines === 1 ? 'line has' : 'lines have'} no known cost and ${data.unknown_cost_lines === 1 ? 'is' : 'are'} left out.`}
              </dd>
            </div>
            {data.by_payment_method.length > 0 && (
              <div className="col-span-2 sm:col-span-4">
                <dt className="text-xs text-muted-foreground">Collected by method</dt>
                <dd className="flex flex-wrap gap-x-4 tabular-nums">
                  {data.by_payment_method.map((row) => (
                    <span key={row.payment_method} className="capitalize">
                      {row.payment_method}: {formatCurrency(row.amount)}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {data.product_sales_total !== null && data.combined_collection_total !== null && (
              <div className="col-span-2 sm:col-span-4">
                <dt className="text-xs text-muted-foreground">Combined collections: product sales + supply collections</dt>
                <dd className="tabular-nums" data-testid="summary-combined">
                  {formatCurrency(data.product_sales_total)} + {formatCurrency(data.amount_collected)} = <span className="font-semibold">{formatCurrency(data.combined_collection_total)}</span>
                </dd>
              </div>
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
