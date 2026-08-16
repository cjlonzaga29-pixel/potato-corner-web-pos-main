'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useMovementProofUrl } from '@/hooks/queries/use-universal-inventory';

interface ViewInventoryMovementProofDialogProps {
  branchId: string | null;
  movementId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Read-only proof viewer for the Admin Reports "Inventory Movement" tab —
 * same shape as ViewPaymentProofDialog/ViewDiscountProofDialog: fetches a
 * fresh signed URL only while open, never eagerly from the report table (the
 * report row only ever carries a proof_available Yes/No flag, so this is the
 * only place a signed URL is requested for this screen).
 */
export function ViewInventoryMovementProofDialog({ branchId, movementId, onOpenChange }: ViewInventoryMovementProofDialogProps) {
  const open = movementId !== null;
  const { data, isLoading, isError } = useMovementProofUrl(branchId, movementId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Inventory Movement Proof</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        )}
        {isError && <p className="py-4 text-sm text-destructive">Failed to load proof photo.</p>}
        {data?.proof_url && (
          // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not an optimizable local asset
          <img src={data.proof_url} alt="Inventory movement proof" className="w-full rounded-md border" />
        )}
        {data && !data.proof_url && !isLoading && <p className="py-4 text-sm text-muted-foreground">No proof photo was captured for this movement.</p>}
      </DialogContent>
    </Dialog>
  );
}
