'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ProductResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProductApiError, useChangeProductStatus, useDeleteProduct } from '@/hooks/queries/use-products';

interface RemoveProductDialogProps {
  product: ProductResponse;
  onOpenChange: (open: boolean) => void;
}

/**
 * POS-PERF-P39 — Archive or Delete from the Products list, through the
 * existing endpoints only. Archive is the lifecycle change the product page
 * already offers (global: off POS at every branch, history kept, restorable).
 * Delete is the existing DELETE, which the server allows only while nothing
 * refers to the product — any recipe line, inventory link, choice, change
 * history or sale makes it refuse (PRODUCT_HAS_DEPENDENCIES), and then this
 * dialog says so and offers Archive. Nothing here removes stock, sales,
 * receipts, deductions or audit history.
 */
export function RemoveProductDialog({ product, onOpenChange }: RemoveProductDialogProps) {
  const changeStatus = useChangeProductStatus(product.id);
  const deleteProduct = useDeleteProduct();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const busy = changeStatus.isPending || deleteProduct.isPending;
  const onPos = (product.branches ?? []).filter((b) => b.is_available).map((b) => b.branch_name);
  const canArchive = product.status !== 'archived';

  async function archive() {
    setError(null);
    try {
      await changeStatus.mutateAsync({ status: 'archived' });
      onOpenChange(false);
    } catch (err) {
      setError({ title: "Couldn't archive this product", message: err instanceof Error ? err.message : 'Please try again.' });
    }
  }

  async function remove() {
    setError(null);
    try {
      await deleteProduct.mutateAsync(product.id);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ProductApiError && err.code === 'PRODUCT_HAS_DEPENDENCIES') {
        setError({
          title: "This product can't be deleted permanently",
          message: `Other records still refer to it — for example its recipe, inventory links, choices, change history or sales. ${
            canArchive ? 'Archive it instead: nothing is lost and it can be restored.' : ''
          }`,
        });
        return;
      }
      setError({ title: "Couldn't delete this product", message: err instanceof Error ? err.message : 'Please try again.' });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg" data-testid="remove-product-dialog">
        <DialogHeader>
          <DialogTitle>Archive or delete {product.name}?</DialogTitle>
          <DialogDescription>Choose what should happen to this product.</DialogDescription>
        </DialogHeader>

        {canArchive && (
          <section className="space-y-2 rounded-md border p-3" aria-labelledby="remove-product-archive">
            <h3 id="remove-product-archive" className="text-sm font-semibold">
              Archive (recommended)
            </h3>
            <p className="text-sm text-muted-foreground">
              {onPos.length > 0
                ? `Takes it off POS at every branch — ${onPos.join(', ')} — not just one.`
                : 'It is not on POS anywhere, and it stops appearing in product pickers.'}{' '}
              Sales, receipts, stock and history are kept, and it can be restored from its product page. To stop selling it at one branch only,
              use Deactivate instead.
            </p>
            <Button variant="outline" onClick={() => void archive()} disabled={busy}>
              {changeStatus.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Archive {product.name}
            </Button>
          </section>
        )}

        <section className="space-y-2 rounded-md border border-destructive/40 p-3" aria-labelledby="remove-product-delete">
          <h3 id="remove-product-delete" className="text-sm font-semibold">
            Delete permanently
          </h3>
          <p className="text-sm text-muted-foreground">
            Only possible while nothing refers to it yet — no recipe, inventory links, choices, change history or sales. This can&apos;t be undone.
          </p>
          <div className="space-y-1">
            <label htmlFor="remove-product-typed" className="text-xs text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">DELETE</span> to confirm.
            </label>
            <Input id="remove-product-typed" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
          </div>
          <Button variant="danger" onClick={() => void remove()} disabled={busy || typed !== 'DELETE'}>
            {deleteProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete permanently
          </Button>
        </section>

        {error && (
          <Alert variant="destructive" data-testid="remove-product-error">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
