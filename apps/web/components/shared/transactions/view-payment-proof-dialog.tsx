'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProofPhotoViewer } from '@/components/shared/transactions/proof-photo-viewer';
import { usePaymentProof } from '@/hooks/queries/use-transactions';

interface ViewPaymentProofDialogProps {
  transactionId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Read-only proof viewer — mark-as-verified is a reserved-but-unbuilt follow
 * up (see Transaction.paymentProofVerifiedAt/paymentProofVerifiedById).
 * Fetches a fresh signed URL only while open, never eagerly from the list.
 * POS-PERF-P40 — adds Download photo and an expired-link reload.
 */
export function ViewPaymentProofDialog({ transactionId, onOpenChange }: ViewPaymentProofDialogProps) {
  const open = transactionId !== null;
  const { data, isLoading, isError, refetch } = usePaymentProof(transactionId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Payment Proof</DialogTitle>
          <DialogDescription className="sr-only">Photo of the customer&apos;s payment confirmation.</DialogDescription>
        </DialogHeader>
        {transactionId && (
          <ProofPhotoViewer
            kind="payment"
            transactionId={transactionId}
            url={data?.payment_proof_url}
            captureType={data?.payment_proof_type}
            uploadedAt={data?.uploaded_at}
            isLoading={isLoading}
            isError={isError}
            onReload={() => void refetch()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
