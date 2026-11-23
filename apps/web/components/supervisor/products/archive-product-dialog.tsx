'use client';

import { useState } from 'react';
import { useRestoreFocus } from '@/hooks/use-restore-focus';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ProductResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useChangeProductStatus } from '@/hooks/queries/use-products';

interface ArchiveProductDialogProps {
  product: ProductResponse;
  onOpenChange: (open: boolean) => void;
}

/**
 * POS-PERF-P39 — Archive from the Products list: the lifecycle change the
 * product page already offers (global: off POS at every branch, history
 * kept, restorable). Permanent deletion is its own action and dialog
 * (PermanentDeleteProductDialog); per-branch Deactivate is separate too.
 */
export function ArchiveProductDialog({ product, onOpenChange }: ArchiveProductDialogProps) {
  const changeStatus = useChangeProductStatus(product.id);
  const restoreFocus = useRestoreFocus();
  const [error, setError] = useState<string | null>(null);
  const busy = changeStatus.isPending;
  const onPos = (product.branches ?? []).filter((b) => b.is_available).map((b) => b.branch_name);

  async function archive() {
    setError(null);
    try {
      await changeStatus.mutateAsync({ status: 'archived' });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Please try again.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent
        size="confirm"
        data-testid="archive-product-dialog"
        // Opened from page state (no DialogTrigger): return focus to the button that opened it.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Archive {product.name}?</DialogTitle>
          <DialogDescription>Archiving can be undone from the product page.</DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {onPos.length > 0
            ? `Takes it off POS at every branch (${onPos.join(', ')}), not just one.`
            : 'It is not on POS anywhere, and it stops appearing in product pickers.'}{' '}
          Sales, receipts, stock and history are kept, and it can be restored. To stop selling it at one branch only, use Deactivate instead.
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Couldn&apos;t archive this product</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void archive()} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Archive {product.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
