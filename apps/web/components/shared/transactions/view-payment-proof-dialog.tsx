'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { usePaymentProof } from '@/hooks/queries/use-transactions';

interface ViewPaymentProofDialogProps {
  transactionId: string | null;
  onOpenChange: (open: boolean) => void;
}

const CAPTURE_MODE_LABEL: Record<string, string> = {
  live_capture: 'Live camera capture',
  gallery_upload: 'Gallery upload',
};

/**
 * Read-only proof viewer — mark-as-verified is a reserved-but-unbuilt follow
 * up (see Transaction.paymentProofVerifiedAt/paymentProofVerifiedById).
 * Fetches a fresh signed URL only while open, never eagerly from the list.
 */
export function ViewPaymentProofDialog({ transactionId, onOpenChange }: ViewPaymentProofDialogProps) {
  const open = transactionId !== null;
  const { data, isLoading, isError } = usePaymentProof(transactionId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Payment Proof</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        )}
        {isError && <p className="py-4 text-sm text-destructive">Failed to load payment proof.</p>}
        {data?.payment_proof_url && (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not an optimizable local asset */}
            <img src={data.payment_proof_url} alt="Payment proof" className="w-full rounded-md border" />
            <p className="text-xs text-muted-foreground">
              {data.payment_proof_type ? CAPTURE_MODE_LABEL[data.payment_proof_type] : ''}
              {data.uploaded_at ? ` · ${new Date(data.uploaded_at).toLocaleString()}` : ''}
            </p>
          </div>
        )}
        {data && !data.payment_proof_url && !isLoading && (
          <p className="py-4 text-sm text-muted-foreground">No payment proof was captured for this transaction.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
