'use client';

import { useState } from 'react';
import { useRestoreFocus } from '@/hooks/use-restore-focus';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ProductDeleteBlocker } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ProductApiError, useDeleteProduct, useProductDeletionPreview } from '@/hooks/queries/use-products';

interface PermanentDeleteProductDialogProps {
  product: { id: string; name: string };
  onOpenChange: (open: boolean) => void;
  /** Called after the product is gone (deleted now, or found already deleted), e.g. to leave its product page. */
  onDeleted?: () => void;
}

const CONFIRM_WORD = 'DELETE';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function blockersFrom(error: unknown): ProductDeleteBlocker[] | null {
  if (!(error instanceof ProductApiError) || error.code !== 'PRODUCT_DELETE_BLOCKED') return null;
  const details = error.details as { blockers?: ProductDeleteBlocker[] } | undefined;
  return Array.isArray(details?.blockers) ? details.blockers : null;
}

/**
 * Product permanent delete — the confirmation. Reads a fresh server preview
 * (branches, sales, branch copies, blockers, and whether this supervisor may
 * delete it at all), states plainly that it is permanent, cannot be restored
 * and that history remains, and needs the word DELETE typed before the
 * delete button is enabled. Cancel and Escape change nothing. A refusal is
 * shown with its specific reason and next step, never a generic error.
 */
export function PermanentDeleteProductDialog({ product, onOpenChange, onDeleted }: PermanentDeleteProductDialogProps) {
  const preview = useProductDeletionPreview(product.id);
  const deleteProduct = useDeleteProduct();
  const restoreFocus = useRestoreFocus();
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<{ title: string; message: string; blockers?: ProductDeleteBlocker[] } | null>(null);
  const busy = deleteProduct.isPending;
  const data = preview.data;
  const name = data?.product.name ?? product.name;
  const alreadyGone = preview.error instanceof ProductApiError && (preview.error.code === 'PRODUCT_ALREADY_DELETED' || preview.error.code === 'PRODUCT_NOT_FOUND');
  const blockers = failure?.blockers ?? data?.blockers ?? [];
  const canSubmit = Boolean(data?.can_delete) && blockers.length === 0 && typed === CONFIRM_WORD && !busy;

  async function confirm() {
    setFailure(null);
    try {
      await deleteProduct.mutateAsync(product.id);
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      const found = blockersFrom(error);
      if (found) {
        setFailure({ title: `${name} can't be deleted yet`, message: 'Something changed since this dialog opened.', blockers: found });
        return;
      }
      if (error instanceof ProductApiError && (error.code === 'PRODUCT_ALREADY_DELETED' || error.code === 'PRODUCT_NOT_FOUND')) {
        onOpenChange(false);
        onDeleted?.();
        return;
      }
      if (error instanceof ProductApiError && error.code === 'PRODUCT_DELETE_FORBIDDEN') {
        setFailure({ title: "You can't delete this product", message: error.message });
        return;
      }
      setFailure({
        title: "Couldn't delete this product",
        message: `${error instanceof Error ? error.message : 'Please try again.'} If you're unsure whether it went through, close this and check the product list: deleting twice is safe.`,
      });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent
        size="confirm"
        data-testid="permanent-delete-product-dialog"
        // Opened from page state (no DialogTrigger): return focus to the button that opened it.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Permanently delete {name}?</DialogTitle>
          <DialogDescription>This removes the product itself, not just from one branch. Read what changes before you confirm.</DialogDescription>
        </DialogHeader>

        {preview.isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <LoadingSpinner size="sm" /> Checking where this product is used…
          </div>
        )}

        {alreadyGone && (
          <Alert>
            <AlertTitle>This product no longer exists</AlertTitle>
            <AlertDescription>It was already deleted. Its sales history is kept. Close this to refresh the list.</AlertDescription>
          </Alert>
        )}

        {preview.isError && !alreadyGone && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Couldn&apos;t check this product</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{preview.error instanceof Error ? preview.error.message : 'Please try again.'} Nothing was deleted.</p>
              <Button size="sm" variant="outline" onClick={() => void preview.refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {data && (
          <div className="space-y-4 text-sm">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Permanent: it cannot be restored</AlertTitle>
              <AlertDescription>Historical records remain. Use Deactivate or Archive instead if you may sell it again.</AlertDescription>
            </Alert>

            <div className="grid gap-4 md:grid-cols-2">
              <section aria-labelledby="pdel-removed" className="space-y-2 rounded-md border p-3">
                <h3 id="pdel-removed" className="font-semibold">
                  What is removed
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>
                    {name} and its {plural(data.size_count, 'size', 'sizes')}, with their recipe, flavor and choice setup
                    {data.has_image ? ', and its photo' : ''}.
                  </li>
                  <li>
                    {data.branches.length === 0 ? (
                      'It is not set up at any branch.'
                    ) : (
                      <>
                        It disappears from Products and from POS at:{' '}
                        <span className="inline-flex flex-wrap gap-1 align-middle" data-testid="pdel-branches">
                          {data.branches.map((branch) => (
                            <Badge key={branch.id} variant={branch.on_pos ? 'active' : 'outline'} className="font-normal">
                              {branch.name}
                              {branch.on_pos ? ' (on POS)' : ''}
                            </Badge>
                          ))}
                        </span>
                      </>
                    )}
                  </li>
                </ul>
              </section>

              <section aria-labelledby="pdel-kept" className="space-y-2 rounded-md border p-3">
                <h3 id="pdel-kept" className="font-semibold">
                  What stays
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>
                    {data.sale_count > 0 ? `All ${plural(data.sale_count, 'past sale', 'past sales')}` : 'Past sales'}, receipts, refunds and reports,
                    still showing this product&apos;s name.
                  </li>
                  <li>Stock levels and stock movements. Nothing is reversed or zeroed.</li>
                  <li>Shared ingredients, flavors, options and other products.</li>
                  {data.branch_copy_count > 0 && <li>{plural(data.branch_copy_count, 'branch copy', 'branch copies')} made from it, as separate products.</li>}
                </ul>
              </section>
            </div>

            {!data.can_delete && (
              <Alert data-testid="pdel-forbidden">
                <AlertTitle>You can&apos;t delete this product</AlertTitle>
                <AlertDescription>{data.forbidden_reason}</AlertDescription>
              </Alert>
            )}

            {blockers.length > 0 && (
              <Alert variant="destructive" data-testid="pdel-blockers">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{failure?.blockers ? failure.title : `${name} can't be deleted yet`}</AlertTitle>
                <AlertDescription>
                  <ul className="mt-1 space-y-2">
                    {blockers.map((blocker) => (
                      <li key={blocker.code}>
                        <p>{blocker.message}</p>
                        <p className="font-medium">{blocker.next_action}</p>
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {data.can_delete && blockers.length === 0 && (
              <div className="space-y-1">
                <label htmlFor="pdel-confirm" className="text-sm text-muted-foreground">
                  Type <span className="font-mono font-semibold text-foreground">{CONFIRM_WORD}</span> to permanently delete {name}.
                </label>
                <Input
                  id="pdel-confirm"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  disabled={busy}
                  className="max-w-xs"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canSubmit) void confirm();
                  }}
                />
              </div>
            )}

            {failure && !failure.blockers && (
              <Alert variant="destructive" data-testid="pdel-error">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{failure.title}</AlertTitle>
                <AlertDescription>{failure.message}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {data?.can_delete && blockers.length === 0 && (
            <Button variant="danger" onClick={() => void confirm()} disabled={!canSubmit}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Permanently delete
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
