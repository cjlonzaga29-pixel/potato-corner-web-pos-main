'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DenominationTable, denominationEntries, denominationTotal, type DenominationQuantities } from '@/components/pos/denomination-table';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { useAuth } from '@/hooks/use-auth';
import { useCurrentShift, useCloseShift, useShiftSummary } from '@/hooks/queries/use-shifts';
import { formatCurrency } from '@/lib/utils';

const VARIANCE_TOLERANCE = 0;
const MIN_EXPLANATION_LENGTH = 50;

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

export default function CloseShiftPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { data: shift, isLoading, isError, refetch } = useCurrentShift(branchId);
  const { data: summaryData } = useShiftSummary(shift?.id);
  const summary = summaryData?.summary;
  const [quantities, setQuantities] = useState<DenominationQuantities>({});
  const [notes, setNotes] = useState('');
  const [varianceExplanation, setVarianceExplanation] = useState('');
  const closeShift = useCloseShift(branchId, shift?.id);

  const actualCash = denominationTotal(quantities);
  const entries = denominationEntries(quantities);
  // expected_closing_cash reflects the live overlay from GET /current
  // (opening cash + cash sales so far) — the same figure the server will
  // recompute authoritatively at close time.
  const expectedCash = shift?.expected_closing_cash ?? shift?.opening_cash_amount ?? 0;
  const variance = useMemo(() => actualCash - expectedCash, [actualCash, expectedCash]);
  const outsideTolerance = Math.abs(variance) > VARIANCE_TOLERANCE;
  const explanationTooShort = outsideTolerance && varianceExplanation.trim().length < MIN_EXPLANATION_LENGTH;

  async function onSubmit() {
    if (!shift || entries.length === 0 || explanationTooShort) return;
    await closeShift.mutateAsync({
      denominations: entries,
      notes: notes || undefined,
      variance_explanation: outsideTolerance ? varianceExplanation : undefined,
    });
    router.push('/branch/shift');
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError) {
    return <ErrorState title="Failed to load shift" retry={() => void refetch()} />;
  }

  if (!shift) {
    return <p className="p-6 text-sm text-destructive">No active shift to close.</p>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold">Close Shift</h1>
        <p className="text-sm text-muted-foreground">Count the cash on hand and enter the breakdown below.</p>
      </div>

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Shift Summary (so far)</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Total Sales</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.total_sales)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cash Sales</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.cash_sales_total)} ({summary.cash_sales_count})</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">GCash Sales</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.gcash_sales_total)} ({summary.gcash_sales_count})</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Transactions</p>
              <p className="font-semibold tabular-nums">{summary.total_transaction_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Voided</p>
              <p className="font-semibold tabular-nums">{summary.voided_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Refunded</p>
              <p className="font-semibold tabular-nums">{summary.refunded_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Discounts</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.total_discount_amount)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid grid-cols-3 gap-4 pt-6 text-center">
          <div>
            <p className="text-xs text-muted-foreground">Expected Cash</p>
            <p className="text-lg font-semibold tabular-nums">{formatPeso(expectedCash)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Actual Cash</p>
            <p className="text-lg font-semibold tabular-nums">{formatPeso(actualCash)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Variance</p>
            <p className={`text-lg font-semibold tabular-nums ${outsideTolerance ? 'text-destructive' : 'text-success'}`}>
              {variance >= 0 ? '+' : ''}
              {formatPeso(variance)}
            </p>
          </div>
        </CardContent>
      </Card>

      <DenominationTable quantities={quantities} onChange={(d, q) => setQuantities((prev) => ({ ...prev, [d]: q }))} />
      {entries.length === 0 && <p className="text-sm text-destructive">Enter at least one denomination.</p>}

      {outsideTolerance && (
        <Card className="border-warning/50">
          <CardHeader>
            <CardTitle className="text-sm text-warning">
              This shift will be flagged for review — a super admin must approve or reject the variance before it counts as fully closed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <label className="text-sm font-medium" htmlFor="variance-explanation">
              Explain the variance<span className="ml-0.5 text-destructive">*</span> (minimum {MIN_EXPLANATION_LENGTH} characters)
            </label>
            <Textarea
              id="variance-explanation"
              rows={3}
              value={varianceExplanation}
              onChange={(e) => setVarianceExplanation(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{varianceExplanation.trim().length}/{MIN_EXPLANATION_LENGTH}</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="shift-notes">
          Notes
        </label>
        <Textarea id="shift-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" disabled={closeShift.isPending || entries.length === 0 || explanationTooShort} onClick={() => void onSubmit()}>
          {closeShift.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Close Shift
        </Button>
      </div>
    </div>
  );
}
