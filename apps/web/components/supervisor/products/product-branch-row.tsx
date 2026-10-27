'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { BranchProductAvailabilityRow, ProductDetailResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ProductWriteError } from '@/components/products/product-write-error';
import {
  PublicationNotConfirmedError,
  useConfirmPublication,
  usePublicationCheck,
  usePublishProduct,
  useUnpublishProduct,
} from '@/hooks/queries/use-products';

interface ProductBranchRowProps {
  product: ProductDetailResponse;
  row: BranchProductAvailabilityRow;
  /** The supervisor is actively assigned to this branch (branch-level actions). */
  assigned: boolean;
  /** The supervisor may edit this product in place (publishing). */
  canEdit: boolean;
}

/**
 * POS-PERF-P39 — one configured branch in the product editor's Branches tab:
 * whether the product is on POS there, Deactivate (that branch only — the
 * same unpublish the product page uses), and Publish, gated on the server's
 * own publication plan for that branch exactly like the product page
 * (POS-PERF-P38R), including the read-only Check again after a lost answer.
 */
export function ProductBranchRow({ product, row, assigned, canEdit }: ProductBranchRowProps) {
  const lifecycleBlocked = product.status === 'archived' || product.status === 'discontinued';
  const canPublishHere = assigned && canEdit && !row.is_available && !lifecycleBlocked;
  const check = usePublicationCheck(product.id, canPublishHere ? [row.branch_id] : []);
  const publish = usePublishProduct(product.id);
  const unpublish = useUnpublishProduct(product.id);
  const confirmPublication = useConfirmPublication(product.id);
  const [publishError, setPublishError] = useState<Error | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const plan = check.data;
  const branchPlan = plan?.branches.find((b) => b.branch_id === row.branch_id);
  const issues = plan ? [...plan.issues, ...(branchPlan?.issues ?? [])] : [];
  const unconfirmed = publishError instanceof PublicationNotConfirmedError && publishError.outcome === 'unknown';
  const otherBranchesOnPos = product.branch_availability.filter((b) => b.is_available && b.branch_id !== row.branch_id).map((b) => b.branch_name);

  async function handlePublish() {
    setPublishError(null);
    try {
      await publish.mutateAsync(row.branch_id);
    } catch (error) {
      setPublishError(error instanceof Error ? error : new Error('Failed to publish this product.'));
    }
  }

  async function handleCheckAgain() {
    if (!(publishError instanceof PublicationNotConfirmedError)) return;
    setChecking(true);
    try {
      const outcome = await confirmPublication([row.branch_id]);
      setPublishError(outcome === 'published' ? null : new PublicationNotConfirmedError(publishError, outcome));
    } finally {
      setChecking(false);
    }
  }

  return (
    <li className="space-y-2 rounded-md border p-3 text-sm" data-testid="product-editor-branch">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{row.branch_name}</p>
          <p className="text-xs text-muted-foreground">{row.branch_code}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={row.is_available ? 'active' : 'outline'}>{row.is_available ? 'On POS' : 'Not on POS'}</Badge>
          {assigned && row.is_available && (
            <Button size="sm" variant="outline" onClick={() => setConfirmDeactivate(true)} disabled={unpublish.isPending}>
              {unpublish.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Deactivate here
            </Button>
          )}
          {canPublishHere && (
            <Button size="sm" onClick={() => void handlePublish()} disabled={!plan?.ready || publish.isPending || checking || unconfirmed}>
              {publish.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Publish here
            </Button>
          )}
        </div>
      </div>

      {!assigned && <p className="text-xs text-muted-foreground">You aren&apos;t assigned to this branch, so its availability is managed by its own supervisor.</p>}
      {assigned && !row.is_available && !canEdit && (
        <p className="text-xs text-muted-foreground">
          Publishing needs authority over every branch this product is set up for. Open the product page to create a branch copy instead.
        </p>
      )}
      {assigned && !row.is_available && lifecycleBlocked && (
        <p className="text-xs text-muted-foreground">This product is {product.status}; restore it from the product page before publishing.</p>
      )}
      {canPublishHere && check.isLoading && <p className="text-xs text-muted-foreground">Checking publication setup…</p>}
      {canPublishHere && check.error && <p className="text-xs text-destructive">Couldn&apos;t check this product: {check.error.message}</p>}
      {canPublishHere && branchPlan && branchPlan.setup_items.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Publishing also adds {branchPlan.setup_items.length === 1 ? 'this item' : `these ${branchPlan.setup_items.length} items`} to this branch&apos;s
          inventory at zero stock: {branchPlan.setup_items.map((item) => item.name).join(', ')}.
        </p>
      )}
      {canPublishHere && issues.length > 0 && (
        <ul className="space-y-1" data-testid="product-editor-branch-issues">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`} className="text-xs text-destructive">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {publishError && !(row.is_available && publishError instanceof PublicationNotConfirmedError) && (
        <ProductWriteError
          error={publishError}
          failedTitle="Couldn't publish this product"
          pausedTitle="Publishing is paused for maintenance"
          testId="product-editor-publish-error"
          onCheckAgain={() => void handleCheckAgain()}
          checking={checking}
        />
      )}

      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title={`Take ${product.name} off POS at ${row.branch_name}?`}
        description={
          <>
            Cashiers at {row.branch_name} can no longer sell it. Its sizes, recipe and choices are kept, and you can publish it here again at any
            time.{' '}
            {otherBranchesOnPos.length > 0
              ? `It stays on POS at ${otherBranchesOnPos.join(', ')}.`
              : 'It is not on POS at any other branch.'}
          </>
        }
        confirmLabel="Deactivate here"
        onConfirm={async () => {
          await unpublish.mutateAsync(row.branch_id);
        }}
      />
    </li>
  );
}
