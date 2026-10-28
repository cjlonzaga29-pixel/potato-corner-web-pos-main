'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProofPhotoViewer } from '@/components/shared/transactions/proof-photo-viewer';
import { usePaymentProof } from '@/hooks/queries/use-transactions';
import { isProofFileMissing } from '@/lib/proof-errors';

interface ViewPaymentProofDialogProps {
  transactionId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close — the caller knows which control opened it (there is no Radix Trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Read-only proof viewer — mark-as-verified is a reserved-but-unbuilt follow
 * up (see Transaction.paymentProofVerifiedAt/paymentProofVerifiedById).
 * Fetches a fresh signed URL only while open, never eagerly from the list.
 * POS-PERF-P40 — adds Download photo and an expired-link reload.
 */
export function ViewPaymentProofDialog({ transactionId, onOpenChange, onCloseAutoFocus }: ViewPaymentProofDialogProps) {
  const open = transactionId !== null;
  const { data, isLoading, isError, error, refetch } = usePaymentProof(transactionId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
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
            isMissing={isProofFileMissing(error)}
            onReload={() => void refetch()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
