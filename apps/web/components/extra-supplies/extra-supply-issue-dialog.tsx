'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useExtraSupplyIssue } from '@/hooks/queries/use-extra-supplies';
import { useRestoreFocus } from '@/hooks/use-restore-focus';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { costSourceLabel } from '@/lib/extra-supply-labels';

/** POS-PERF-P61 — one posted issue, what it snapshotted, and the stock movements it wrote. Read only: a posted issue can't be edited or deleted. */
export function ExtraSupplyIssueDialog({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const restoreFocus = useRestoreFocus();
  const { data: issue, isLoading, error } = useExtraSupplyIssue(issueId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto" onCloseAutoFocus={restoreFocus} data-testid="extra-supply-issue-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-base [overflow-wrap:anywhere]">{issue?.reference_number ?? 'Issue'}</DialogTitle>
          <DialogDescription>{issue ? `${formatDateTime(issue.created_at)} at ${issue.branch_name}, by ${issue.cashier_name}` : 'Posted issues are not edited or deleted.'}</DialogDescription>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
        {issue && (
          <div className="space-y-4 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge variant={issue.kind === 'paid' ? 'default' : 'secondary'}>{issue.kind === 'paid' ? 'Paid' : 'Free'}</Badge>
              {issue.kind === 'paid' && (
                <span className="tabular-nums" data-testid="issue-detail-amount">
                  {formatCurrency(issue.amount_collected)} by {issue.payment_method}
                </span>
              )}
              {issue.amount_tendered !== null && <span className="tabular-nums text-muted-foreground">received {formatCurrency(issue.amount_tendered)}, change {formatCurrency(issue.change_amount ?? 0)}</span>}
            </p>
            {issue.reason && <p className="[overflow-wrap:anywhere]">Reason: {issue.reason}</p>}
            {issue.order_reference && <p className="[overflow-wrap:anywhere]">Order reference (as typed): {issue.order_reference}</p>}
            {issue.payment_reference && <p className="[overflow-wrap:anywhere]">Payment reference: {issue.payment_reference}</p>}
            {issue.has_payment_proof && <p>Payment proof attached.</p>}

            <section className="space-y-1">
              <h3 className="font-medium">Supplies</h3>
              <ul className="divide-y rounded-md border">
                {issue.lines.map((line) => (
                  <li key={line.id} className="space-y-0.5 p-2">
                    <p className="[overflow-wrap:anywhere]">
                      {line.quantity} {line.issue_unit_name} of {line.supply_name}
                      {line.current_supply_name !== line.supply_name && <span className="text-muted-foreground"> (now called {line.current_supply_name})</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {line.base_quantity_total} {line.base_unit_code} of {line.inventory_item_name}
                      {line.unit_price !== null && ` · ${formatCurrency(line.unit_price)} each`}
                      {' · '}
                      {line.line_cost !== null ? `${costSourceLabel(line.cost_source)} ${formatCurrency(line.line_cost)}` : costSourceLabel(line.cost_source)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-1">
              <h3 className="font-medium">Stock movements</h3>
              <ul className="divide-y rounded-md border" data-testid="issue-detail-movements">
                {issue.movements.map((movement) => (
                  <li key={movement.id} className="p-2 tabular-nums">
                    {movement.inventory_item_name}: {movement.quantity_change} {movement.unit_code}, from {movement.quantity_before} to {movement.quantity_after}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
