'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranches } from '@/hooks/queries/use-branches';
import { downloadExtraSupplyCsv, useExtraSupplies, useExtraSupplyIssues, useExtraSupplySummary, type ExtraSupplyIssueFilters } from '@/hooks/queries/use-extra-supplies';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { costSourceLabel } from '@/lib/extra-supply-labels';
import { manilaDaysAgo, manilaToday } from '@/lib/manila-date';
import { ExtraSupplyIssueDialog } from './extra-supply-issue-dialog';

const PAGE_SIZE = 20;
const ALL = 'all';

interface ExtraSupplyHistoryProps {
  /** Pins the view to one branch. Otherwise the branch filter offers what the server allows this caller. */
  fixedBranchId?: string;
}

/**
 * POS-PERF-P61 — one history for every role, over the issue records themselves. The
 * server scopes every read to the caller's live branches, and every total is the
 * whole filtered period, not the page on screen.
 */
export function ExtraSupplyHistory({ fixedBranchId }: ExtraSupplyHistoryProps) {
  const search = useSearchParams();
  const [branchId, setBranchId] = useState(search.get('branch_id') ?? ALL);
  const [dateFrom, setDateFrom] = useState(search.get('date_from') ?? manilaDaysAgo(6));
  const [dateTo, setDateTo] = useState(search.get('date_to') ?? manilaToday());
  const [supplyId, setSupplyId] = useState(search.get('extra_supply_id') ?? ALL);
  const [kind, setKind] = useState(search.get('kind') ?? ALL);
  const [cashierId, setCashierId] = useState(search.get('cashier_id') ?? ALL);
  const [page, setPage] = useState(1);
  const [openIssueId, setOpenIssueId] = useState<string | null>(search.get('issue'));
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const effectiveBranch = fixedBranchId ?? (branchId === ALL ? undefined : branchId);
  const filters: ExtraSupplyIssueFilters = {
    branchId: effectiveBranch,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    extraSupplyId: supplyId === ALL ? undefined : supplyId,
    kind: kind === 'free' || kind === 'paid' ? kind : undefined,
    cashierId: cashierId === ALL ? undefined : cashierId,
  };

  const branches = useBranches({ limit: 100 }, );
  const supplies = useExtraSupplies({ branchId: effectiveBranch });
  const issues = useExtraSupplyIssues(filters, page, PAGE_SIZE);
  const summary = useExtraSupplySummary(filters);
  const pageCount = issues.data ? Math.max(1, Math.ceil(issues.data.total / PAGE_SIZE)) : 1;

  /** A filter change always returns to the first page, so a smaller result can't land past its end. */
  function changed<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  async function exportCsv() {
    setExportError(null);
    setIsExporting(true);
    try {
      await downloadExtraSupplyCsv(filters);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : 'The export could not be created.');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="extra-supply-history">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {!fixedBranchId && (
          <div className="space-y-1">
            <Label htmlFor="history-branch">Branch</Label>
            <Select value={branchId} onValueChange={changed(setBranchId)}>
              <SelectTrigger id="history-branch" aria-label="Branch filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All branches</SelectItem>
                {(branches.data?.branches ?? []).map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="history-from">From</Label>
          <Input id="history-from" type="date" value={dateFrom} onChange={(event) => changed(setDateFrom)(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-to">To</Label>
          <Input id="history-to" type="date" value={dateTo} onChange={(event) => changed(setDateTo)(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-item">Item</Label>
          <Select value={supplyId} onValueChange={changed(setSupplyId)}>
            <SelectTrigger id="history-item" aria-label="Item filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All items</SelectItem>
              {(supplies.data ?? []).map((supply) => (
                <SelectItem key={supply.id} value={supply.id}>{supply.name}{supply.is_active ? '' : ' (deactivated)'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-kind">Free or paid</Label>
          <Select value={kind} onValueChange={changed(setKind)}>
            <SelectTrigger id="history-kind" aria-label="Free or paid filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Free and paid</SelectItem>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-cashier">Cashier</Label>
          <Select value={cashierId} onValueChange={changed(setCashierId)}>
            <SelectTrigger id="history-cashier" aria-label="Cashier filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All cashiers</SelectItem>
              {(summary.data?.by_cashier ?? []).map((cashier) => (
                <SelectItem key={cashier.cashier_id} value={cashier.cashier_id}>{cashier.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {summary.data ? (
        <dl className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm sm:grid-cols-3 lg:grid-cols-5" data-testid="history-totals">
          <div>
            <dt className="text-xs text-muted-foreground">Issues</dt>
            <dd className="font-semibold tabular-nums" data-testid="history-issue-count">{summary.data.issue_count}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Units free</dt>
            <dd className="font-semibold tabular-nums" data-testid="history-units-free">{summary.data.units_free}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Units paid</dt>
            <dd className="font-semibold tabular-nums" data-testid="history-units-paid">{summary.data.units_paid}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Supply collections</dt>
            <dd className="font-semibold tabular-nums" data-testid="history-collected">{formatCurrency(summary.data.amount_collected)}</dd>
            <dd className="text-xs capitalize text-muted-foreground">{summary.data.by_payment_method.map((row) => `${row.payment_method} ${formatCurrency(row.amount)}`).join(' · ')}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cost of supplies issued</dt>
            <dd className="font-semibold tabular-nums" data-testid="history-cost">{formatCurrency(summary.data.inventory_cost)}</dd>
            <dd className="text-xs text-muted-foreground">
              From inventory cost.
              {summary.data.configured_cost > 0 && ` Plus ${formatCurrency(summary.data.configured_cost)} stated on cards.`}
              {summary.data.unknown_cost_lines > 0 && ` ${summary.data.unknown_cost_lines} with no known cost left out.`}
            </dd>
          </div>
          {summary.data.combined_collection_total !== null && summary.data.product_sales_total !== null && (
            <div className="col-span-2 sm:col-span-3 lg:col-span-5">
              <dt className="text-xs text-muted-foreground">Combined collections: product sales + supply collections</dt>
              <dd className="tabular-nums" data-testid="history-combined">
                {formatCurrency(summary.data.product_sales_total)} + {formatCurrency(summary.data.amount_collected)} = <span className="font-semibold">{formatCurrency(summary.data.combined_collection_total)}</span>
              </dd>
            </div>
          )}
        </dl>
      ) : summary.isError ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{summary.error.message}</AlertDescription></Alert>
      ) : (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">Loading totals…</p>
      )}

      {summary.data && summary.data.by_branch.length > 1 && (
        <section className="overflow-x-auto rounded-md border" aria-label="By branch" data-testid="history-by-branch">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2 font-medium">Branch</th>
                <th className="p-2 text-right font-medium">Free</th>
                <th className="p-2 text-right font-medium">Paid</th>
                <th className="p-2 text-right font-medium">Collected</th>
                <th className="p-2 text-right font-medium">Inventory cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.data.by_branch.map((row) => (
                <tr key={row.branch_id} className="border-t">
                  <td className="p-2 [overflow-wrap:anywhere]">{row.branch_name}</td>
                  <td className="p-2 text-right tabular-nums">{row.units_free}</td>
                  <td className="p-2 text-right tabular-nums">{row.units_paid}</td>
                  <td className="p-2 text-right tabular-nums">{formatCurrency(row.amount_collected)}</td>
                  <td className="p-2 text-right tabular-nums">{formatCurrency(row.inventory_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" className="gap-2" onClick={() => void exportCsv()} disabled={isExporting} data-testid="history-export">
          <Download className="h-4 w-4" aria-hidden="true" />
          {isExporting ? 'Preparing…' : 'Export CSV'}
        </Button>
      </div>
      {exportError && <Alert variant="destructive" role="alert"><AlertDescription>{exportError}</AlertDescription></Alert>}

      {issues.isError && <Alert variant="destructive" role="alert"><AlertDescription>{issues.error.message}</AlertDescription></Alert>}
      {issues.data?.total === 0 && <EmptyState title="Nothing issued" description="No extra supplies match these filters." />}

      {issues.data && issues.data.issues.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[46rem] text-sm" data-testid="history-table">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2 font-medium">Issued</th>
                <th className="p-2 font-medium">Reference</th>
                <th className="p-2 font-medium">Branch</th>
                <th className="p-2 font-medium">By</th>
                <th className="p-2 font-medium">Supplies</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 text-right font-medium">Collected</th>
                <th className="p-2 text-right font-medium">Cost</th>
                <th className="p-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {issues.data.issues.map((issue) => {
                const known = issue.lines.filter((line) => line.line_cost !== null);
                const sources = [...new Set(known.map((line) => line.cost_source))];
                return (
                  <tr key={issue.id} className="border-t align-top" data-testid="history-row">
                    <td className="p-2 whitespace-nowrap">{formatDateTime(issue.created_at)}</td>
                    <td className="p-2">
                      <button type="button" className="font-mono text-xs text-primary underline-offset-2 hover:underline" onClick={() => setOpenIssueId(issue.id)}>
                        {issue.reference_number}
                      </button>
                    </td>
                    <td className="p-2 [overflow-wrap:anywhere]">{issue.branch_name}</td>
                    <td className="p-2 [overflow-wrap:anywhere]">{issue.cashier_name}</td>
                    <td className="p-2 [overflow-wrap:anywhere]">{issue.lines.map((line) => `${line.quantity} ${line.supply_name}`).join(', ')}</td>
                    <td className="p-2"><Badge variant={issue.kind === 'paid' ? 'default' : 'secondary'}>{issue.kind === 'paid' ? 'Paid' : 'Free'}</Badge></td>
                    <td className="p-2 text-right tabular-nums">
                      {issue.kind === 'paid' ? formatCurrency(issue.amount_collected) : '—'}
                      {issue.payment_method && <span className="block text-xs capitalize text-muted-foreground">{issue.payment_method}</span>}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {known.length > 0 ? formatCurrency(known.reduce((sum, line) => sum + (line.line_cost ?? 0), 0)) : '—'}
                      <span className="block text-xs text-muted-foreground">{known.length === issue.lines.length ? sources.map(costSourceLabel).join(', ') : costSourceLabel('unknown')}</span>
                    </td>
                    <td className="p-2 [overflow-wrap:anywhere]">{issue.reason ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {issues.data && issues.data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <Button variant="outline" size="sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>Previous</Button>
          <span data-testid="history-page">Page {page} of {pageCount}</span>
          <Button variant="outline" size="sm" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>Next</Button>
        </div>
      )}

      {openIssueId && <ExtraSupplyIssueDialog issueId={openIssueId} onClose={() => setOpenIssueId(null)} />}
    </div>
  );
}
