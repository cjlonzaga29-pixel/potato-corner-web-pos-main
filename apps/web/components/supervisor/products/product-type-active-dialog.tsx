'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductTypeResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSetProductTypeActive } from '@/hooks/queries/use-product-types';
import { useRestoreFocus } from '@/hooks/use-restore-focus';

interface ProductTypeActiveDialogProps {
  type: ProductTypeResponse;
  onOpenChange: (open: boolean) => void;
}

/** POS-PERF-P58 — Deactivate or Reactivate a custom type. Neither touches a single product. */
export function ProductTypeActiveDialog({ type, onOpenChange }: ProductTypeActiveDialogProps) {
  const restoreFocus = useRestoreFocus();
  const setActive = useSetProductTypeActive(type.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const deactivating = type.is_active;
  const count = type.product_count ?? 0;

  async function handleConfirm() {
    setError(null);
    try {
      await setActive.mutateAsync({ isActive: !deactivating, expectedVersion: type.version });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to change this product type.');
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !setActive.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md" onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{deactivating ? `Deactivate ${type.name}?` : `Reactivate ${type.name}?`}</DialogTitle>
          <DialogDescription>
            {deactivating
              ? 'New products can no longer use this type. Nothing else changes.'
              : 'Products can use this type again.'}
          </DialogDescription>
        </DialogHeader>
        {deactivating && (
          <p className="text-sm">
            {count === 1 ? '1 product keeps' : `${count} products keep`} this type and can still be found and edited. They stay on POS as they are, with the same prices and stock.
          </p>
        )}
        {error && (
          <p className="text-sm font-medium text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={setActive.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={setActive.isPending} data-testid="product-type-active-confirm">
            {setActive.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {deactivating ? 'Deactivate Type' : 'Reactivate Type'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
