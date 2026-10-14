'use client';

import type { ProductDetailResponse } from '@potato-corner/shared';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useReplaceSourceWithCopy } from '@/hooks/queries/use-products';

interface ReplaceSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  copy: ProductDetailResponse;
  branchId: string;
}

/**
 * POS-PERF-P36R5 — explicit replacement. This is the one action that makes
 * a branch copy sellable at its branch by disabling the source there, in
 * one atomic request (products.service.ts's replaceSharedProductAtBranch
 * validates the copy's readiness first; neither row changes if it's not
 * ready). Never inferred automatically from publishing or editing the copy
 * — the supervisor has to land on this exact dialog and confirm.
 */
export function ReplaceSourceDialog({ open, onOpenChange, copy, branchId }: ReplaceSourceDialogProps) {
  const replace = useReplaceSourceWithCopy(copy.id, copy.forked_from_product_id ?? '');

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Replace source product at this branch?"
      description={
        <>
          This makes &ldquo;{copy.name}&rdquo; (your branch copy) the sellable product at your branch and disables the
          original shared product here only. Every other branch selling the original product is unaffected, and its sales
          history is untouched. This can be reversed by publishing the original again and unpublishing the copy.
        </>
      }
      confirmLabel="Replace"
      onConfirm={async () => {
        await replace.mutateAsync(branchId);
      }}
    />
  );
}
