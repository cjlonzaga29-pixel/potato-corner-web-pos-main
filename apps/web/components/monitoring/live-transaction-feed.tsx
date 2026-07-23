'use client';

import { useEffect, useRef, useState } from 'react';
import { Receipt } from 'lucide-react';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { TransactionResponse } from '@potato-corner/shared';
import { useRealtimeFeed } from '@/hooks/use-realtime-feed';
import { useBranches } from '@/hooks/queries/use-branches';
import { useEmployees } from '@/hooks/queries/use-employees';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { cn, formatTimeAgo } from '@/lib/utils';

interface RefundPayload {
  transactionId: string;
  branchId: string;
  amount: number;
}

const FEED_MAX_SIZE = 20;

export function LiveTransactionFeed() {
  const entries = useRealtimeFeed<TransactionResponse | RefundPayload>(
    [SOCKET_EVENTS.TRANSACTION_COMPLETED, SOCKET_EVENTS.TRANSACTION_REFUNDED],
    FEED_MAX_SIZE,
  );
  const { data: branchesData } = useBranches({ limit: 100 });
  const { data: employeesData } = useEmployees({ limit: 100 });

  const branchNameById = new Map((branchesData?.branches ?? []).map((b) => [b.id, b.name]));
  const employeeNameById = new Map(
    (employeesData?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]),
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [seenCount, setSeenCount] = useState(0);

  useEffect(() => {
    if (paused) return;
    setSeenCount(entries.length);
    containerRef.current?.scrollTo?.({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length, paused]);

  const newCount = paused ? entries.length - seenCount : 0;

  function jumpToNewest() {
    setPaused(false);
    setSeenCount(entries.length);
    containerRef.current?.scrollTo?.({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" />
          Live Transaction Feed
        </CardTitle>
      </CardHeader>
      <CardContent>
        {newCount > 0 && (
          <Button type="button" size="sm" onClick={jumpToNewest} className="mb-2 w-full">
            {newCount} new event{newCount === 1 ? '' : 's'}
          </Button>
        )}
        <div
          ref={containerRef}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          className="max-h-72 space-y-2 overflow-y-auto"
        >
          {entries.length === 0 ? (
            <EmptyState icon={Receipt} title="Waiting for activity..." />
          ) : (
            entries.map((entry) => {
              const isRefund = entry.event === SOCKET_EVENTS.TRANSACTION_REFUNDED;
              const branchId = 'branch_id' in entry.payload ? entry.payload.branch_id : entry.payload.branchId;
              const cashierId = 'cashier_id' in entry.payload ? entry.payload.cashier_id : null;
              const amount = 'total_amount' in entry.payload ? entry.payload.total_amount : entry.payload.amount;
              const paymentMethod = 'payment_method' in entry.payload ? entry.payload.payment_method : null;

              return (
                <div key={entry.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{cashierId ? (employeeNameById.get(cashierId) ?? 'Unknown cashier') : 'System'}</span>
                      <Badge variant={isRefund ? 'critical' : 'secondary'} className="text-[10px]">
                        {isRefund ? 'Refund' : 'Sale'}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {branchNameById.get(branchId) ?? 'Unknown branch'}
                      {paymentMethod ? ` · ${paymentMethod}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={cn('font-semibold', isRefund && 'text-destructive')}>
                      {isRefund ? '-' : ''}₱{amount.toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatTimeAgo(new Date(entry.receivedAt))}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
