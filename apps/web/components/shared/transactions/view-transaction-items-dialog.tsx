'use client';

import type { TransactionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/utils';

interface ViewTransactionItemsDialogProps {
  transaction: TransactionResponse | null;
  onClose: () => void;
}

/**
 * Per-product breakdown for one receipt, opened from the Sold Product
 * Transactions report's "View Items" action — keeps that table to one row
 * per transaction (so Subtotal/VAT/Discount/Total are never repeated per
 * product line) while still exposing product/variant/quantity/unit price.
 */
export function ViewTransactionItemsDialog({ transaction, onClose }: ViewTransactionItemsDialogProps) {
  return (
    <Dialog open={transaction !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Items — Receipt {transaction?.receipt_number}</DialogTitle>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Unit Price</TableHead>
              <TableHead>Line Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(transaction?.items ?? []).map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  {item.product_name}
                  {item.flavor_name ? ` — ${item.flavor_name}` : ''}
                </TableCell>
                <TableCell>{item.variant_name}</TableCell>
                <TableCell className="tabular-nums">{item.quantity}</TableCell>
                <TableCell className="tabular-nums">{formatCurrency(item.unit_price)}</TableCell>
                <TableCell className="tabular-nums">{formatCurrency(item.line_total)}</TableCell>
              </TableRow>
            ))}
            {(transaction?.items ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  No item detail available for this transaction.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}
