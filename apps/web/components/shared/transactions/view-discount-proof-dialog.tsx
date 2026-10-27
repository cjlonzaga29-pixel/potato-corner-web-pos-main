'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProofPhotoViewer } from '@/components/shared/transactions/proof-photo-viewer';
import { useDiscountProof } from '@/hooks/queries/use-transactions';
import { isProofFileMissing } from '@/lib/proof-errors';

interface ViewDiscountProofDialogProps {
  transactionId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Task 209.5 — read-only PWD/Senior Citizen discount-proof viewer, same
 * shape as ViewPaymentProofDialog: fetches a fresh signed URL only while
 * open (useDiscountProof's `enabled` gate), never eagerly from the report
 * table. POS-PERF-P40 — an expired link can now be reloaded in place, and
 * Download photo saves the original file.
 */
export function ViewDiscountProofDialog({ transactionId, onOpenChange }: ViewDiscountProofDialogProps) {
  const open = transactionId !== null;
  const { data, isLoading, isError, error, refetch } = useDiscountProof(transactionId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Discount Proof</DialogTitle>
          <DialogDescription className="sr-only">Photo of the PWD or Senior Citizen ID used for the discount.</DialogDescription>
        </DialogHeader>
        {transactionId && (
          <ProofPhotoViewer
            kind="discount"
            transactionId={transactionId}
            url={data?.discount_proof_url}
            captureType={data?.discount_proof_type}
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
