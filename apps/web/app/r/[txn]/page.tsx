'use client';

import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/shared/status-badge';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { usePublicReceipt } from '@/hooks/queries/use-receipts';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

/** Public, unauthenticated e-receipt view — destination of the link/QR code printed on a physical receipt. transaction_number IS the receipt number, used as-is in the URL. */
export default function PublicReceiptPage() {
  const params = useParams<{ txn: string }>();
  const { data: receipt, isLoading, isError, refetch } = usePublicReceipt(params.txn);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !receipt) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <ErrorState title="Receipt not found" description="Check the link and try again." retry={() => void refetch()} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen justify-center bg-muted/30 p-4">
      <Card className="h-fit w-full max-w-sm">
        <CardContent className="space-y-3 p-6 text-sm">
          <div id="receipt-print-area" className="space-y-3">
            <div className="text-center">
              <p className="font-semibold">Potato Corner</p>
              <p className="text-xs text-muted-foreground">{receipt.branch_name}</p>
              <p className="text-xs text-muted-foreground">{new Date(receipt.created_at).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Receipt No. {receipt.receipt_number}</p>
              <div className="mt-1 flex justify-center">
                <StatusBadge status={receipt.status} type="transaction" />
              </div>
            </div>

            <div className="space-y-1 border-y py-2">
              {receipt.items.map((item, index) => (
                <div key={index} className="flex justify-between gap-2">
                  <span>
                    {item.quantity}x {item.product_name}
                    {item.flavor_name ? ` (${item.flavor_name})` : ''} — {item.variant_name}
                  </span>
                  <span className="tabular-nums">{formatPeso(item.line_total)}</span>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatPeso(receipt.subtotal)}</span>
              </div>
              {receipt.discount_amount > 0 && (
                <div className="flex justify-between">
                  <span>Discount {receipt.discount_type ? `(${receipt.discount_type})` : ''}</span>
                  <span className="tabular-nums">-{formatPeso(receipt.discount_amount)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>VAT (12%)</span>
                <span className="tabular-nums">{formatPeso(receipt.vat_amount)}</span>
              </div>
              <div className="flex justify-between border-t pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatPeso(receipt.total_amount)}</span>
              </div>
              {receipt.payment_method === 'cash' ? (
                <>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Cash Tendered</span>
                    <span className="tabular-nums">{formatPeso(receipt.cash_tendered ?? 0)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Change</span>
                    <span className="tabular-nums">{formatPeso(receipt.change_given ?? 0)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>GCash Ref.</span>
                  <span>{receipt.gcash_reference_number}</span>
                </div>
              )}
            </div>
          </div>

          <Button variant="outline" className="w-full" onClick={() => window.print()}>
            Print
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
