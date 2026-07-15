'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { useCurrentShift } from '@/hooks/queries/use-shifts';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

function formatElapsed(startedAt: string, now: Date | null): string {
  if (!now) return '--:--:--';
  const ms = now.getTime() - new Date(startedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

/** Starts null so server/first-client render agree, then ticks every second — same pattern as PosHeader's clock. */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

export default function ShiftDashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { data: shift, isLoading } = useCurrentShift(branchId);
  const now = useNow();

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned.</p>;
  }

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading shift…</p>;
  }

  if (!shift) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <h1 className="text-xl font-bold">No active shift</h1>
        <p className="text-sm text-muted-foreground">Open a shift to start taking orders.</p>
        <Button onClick={() => router.push('/shift/open')}>Open Shift</Button>
      </div>
    );
  }

  const openingDenominations = shift.denominations?.filter((d) => d.phase === 'opening') ?? [];
  const openedByMe = shift.opened_by === user?.id;

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Current Shift</h1>
        <Button variant="danger" onClick={() => router.push('/shift/close')}>
          Close Shift
        </Button>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-6 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Opened By</p>
            <p className="font-medium">{openedByMe ? 'You' : shift.opened_by.slice(0, 8)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Opened At</p>
            <p className="font-medium">{new Date(shift.started_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Time Elapsed</p>
            <p className="font-medium tabular-nums">{formatElapsed(shift.started_at, now)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Starting Cash</p>
            <p className="font-medium tabular-nums">{formatPeso(shift.opening_cash_amount)}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sales So Far</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Cash Sales</p>
            <p className="font-medium tabular-nums">{formatPeso(shift.cash_sales_total)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">GCash Sales</p>
            <p className="font-medium tabular-nums">{formatPeso(shift.gcash_sales_total)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Transactions</p>
            <p className="font-medium tabular-nums">{shift.transaction_count}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Opening Denomination Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Denomination</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {openingDenominations.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{formatPeso(d.denomination)}</TableCell>
                  <TableCell>{d.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPeso(d.subtotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
