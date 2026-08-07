'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useDiscountProof } from '@/hooks/queries/use-transactions';

interface ViewDiscountProofDialogProps {
  transactionId: string | null;
  onOpenChange: (open: boolean) => void;
}

const CAPTURE_MODE_LABEL: Record<string, string> = {
  live_capture: 'Live camera capture',
  gallery_upload: 'Gallery upload',
};

/**
 * Task 209.5 — read-only PWD/Senior Citizen discount-proof viewer, same
 * shape as ViewPaymentProofDialog: fetches a fresh signed URL only while
 * open (useDiscountProof's `enabled` gate), never eagerly from the report
 * table. A stale/expired signed URL is refreshed by simply reopening the
 * dialog, which re-fires the query.
 */
export function ViewDiscountProofDialog({ transactionId, onOpenChange }: ViewDiscountProofDialogProps) {
  const open = transactionId !== null;
  const { data, isLoading, isError } = useDiscountProof(transactionId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Discount Proof</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        )}
        {isError && <p className="py-4 text-sm text-destructive">Failed to load discount proof.</p>}
        {data?.discount_proof_url && (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not an optimizable local asset */}
            <img src={data.discount_proof_url} alt="Discount proof" className="w-full rounded-md border" />
            <p className="text-xs text-muted-foreground">
              {data.discount_proof_type ? CAPTURE_MODE_LABEL[data.discount_proof_type] : ''}
              {data.uploaded_at ? ` · ${new Date(data.uploaded_at).toLocaleString()}` : ''}
            </p>
          </div>
        )}
        {data && !data.discount_proof_url && !isLoading && (
          <p className="py-4 text-sm text-muted-foreground">No discount proof was captured for this transaction.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
