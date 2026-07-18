import type { TransactionResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency, formatTimeAgo } from '@/lib/utils';

/**
 * Local status->variant map, same pattern as ShiftStatusBadge — StatusBadge
 * has no 'transaction' StatusType (only product/employee/shift/inventory/
 * fraud/attendance/gps/general), so this stays local rather than widening
 * the shared map for a single dashboard panel.
 */
const STATUS_VARIANT: Record<TransactionResponse['status'], 'active' | 'critical' | 'warning'> = {
  completed: 'active',
  voided: 'critical',
  refunded: 'warning',
};

const STATUS_LABEL: Record<TransactionResponse['status'], string> = {
  completed: 'Completed',
  voided: 'Voided',
  refunded: 'Refunded',
};

const PAYMENT_METHOD_LABEL: Record<TransactionResponse['payment_method'], string> = {
  cash: 'Cash',
  gcash: 'GCash',
};

interface DashboardTransactionsFeedProps {
  transactions: TransactionResponse[] | undefined;
  isLoading: boolean;
  onRowClick?: () => void;
}

/** Panel 5 of the supervisor dashboard — the branch's most recent transactions. Pure display, no data fetching. */
export function DashboardTransactionsFeed({ transactions, isLoading, onRowClick }: DashboardTransactionsFeedProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!transactions || transactions.length === 0) {
    return <EmptyState title="No transactions this shift" />;
  }

  return (
    <div className="space-y-2">
      {transactions.map((transaction) => (
        <div
          key={transaction.id}
          onClick={onRowClick}
          className={onRowClick ? 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted/50' : 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm'}
        >
          <span className="min-w-0 truncate font-medium">{transaction.receipt_number}</span>
          <Badge variant={STATUS_VARIANT[transaction.status]}>{STATUS_LABEL[transaction.status]}</Badge>
          <Badge variant="outline">{PAYMENT_METHOD_LABEL[transaction.payment_method]}</Badge>
          <span className="tabular-nums">{formatCurrency(transaction.total_amount)}</span>
          <span className="text-xs text-muted-foreground">{formatTimeAgo(transaction.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
