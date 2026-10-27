'use client';

import type { ProductResponse } from '@potato-corner/shared';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useUnpublishProduct } from '@/hooks/queries/use-products';

interface DeactivateProductDialogProps {
  product: ProductResponse;
  branch: { id: string; name: string };
  onOpenChange: (open: boolean) => void;
}

/**
 * POS-PERF-P39 — Deactivate on the Products list: takes the product off POS
 * at the selected branch only (the same per-branch unpublish the product page
 * uses). It never changes the product's global status, so a shared product
 * stays on POS everywhere else.
 */
export function DeactivateProductDialog({ product, branch, onOpenChange }: DeactivateProductDialogProps) {
  const unpublish = useUnpublishProduct(product.id);
  const elsewhere = (product.branches ?? []).filter((b) => b.is_available && b.branch_id !== branch.id).map((b) => b.branch_name);

  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Deactivate ${product.name} at ${branch.name}?`}
      description={
        <>
          It comes off POS at {branch.name} only, so cashiers there can no longer sell it. Its sizes, recipe and choices are kept and you can
          publish it there again at any time.{' '}
          {elsewhere.length > 0 ? `It stays on POS at ${elsewhere.join(', ')}.` : 'It is not on POS at any other branch.'}
        </>
      }
      confirmLabel={`Deactivate at ${branch.name}`}
      onConfirm={async () => {
        await unpublish.mutateAsync(branch.id);
      }}
    />
  );
}
