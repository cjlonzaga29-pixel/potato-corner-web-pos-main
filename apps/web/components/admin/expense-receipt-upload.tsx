'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { ExternalLink, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useUploadExpenseReceipt, useDeleteExpenseReceipt } from '@/hooks/queries/use-expenses';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface ExpenseReceiptUploadProps {
  expenseId: string;
  currentReceiptUrl: string | null;
  onSuccess?: () => void;
}

export function ExpenseReceiptUpload({ expenseId, currentReceiptUrl, onSuccess }: ExpenseReceiptUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const uploadReceipt = useUploadExpenseReceipt(expenseId);
  const deleteReceipt = useDeleteExpenseReceipt(expenseId);

  function resetSelection() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(null);
    setPreviewUrl(null);
    setValidationError(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;

    if (selected.size > MAX_FILE_SIZE_BYTES) {
      setValidationError('Image must be 5MB or smaller');
      return;
    }
    if (!ACCEPTED_MIME_TYPES.includes(selected.type)) {
      setValidationError('Image must be JPEG, PNG, or WebP');
      return;
    }

    setValidationError(null);
    setPendingFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  }

  async function handleUpload() {
    if (!pendingFile) return;
    await uploadReceipt.mutateAsync(pendingFile);
    resetSelection();
    onSuccess?.();
  }

  async function handleDeleteConfirm() {
    await deleteReceipt.mutateAsync();
    setDeleteDialogOpen(false);
    onSuccess?.();
  }

  const isBusy = uploadReceipt.isPending || deleteReceipt.isPending;

  if (currentReceiptUrl && !pendingFile) {
    return (
      <div className="space-y-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not an optimizable remote asset */}
        <img src={currentReceiptUrl} alt="Receipt" className="max-h-[200px] rounded-md border object-contain" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={isBusy} onClick={() => fileInputRef.current?.click()}>
            {uploadReceipt.isPending && <LoadingSpinner size="sm" className="mr-2 text-current" />}
            Replace
          </Button>
          <Button type="button" variant="danger" disabled={isBusy} onClick={() => setDeleteDialogOpen(true)}>
            {deleteReceipt.isPending && <LoadingSpinner size="sm" className="mr-2 text-current" />}
            Delete
          </Button>
          <Button type="button" variant="ghost" asChild disabled={isBusy}>
            <a href={currentReceiptUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open full image
            </a>
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        {validationError && <p className="text-sm text-destructive">{validationError}</p>}

        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="Delete receipt?"
          description="This removes the attached receipt image. The expense itself is not affected."
          confirmLabel="Delete Receipt"
          variant="danger"
          onConfirm={handleDeleteConfirm}
        />
      </div>
    );
  }

  if (pendingFile && previewUrl) {
    return (
      <div className="space-y-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
        <img src={previewUrl} alt="Receipt preview" className="max-h-[200px] rounded-md border object-contain" />
        <div className="flex gap-2">
          <Button type="button" onClick={() => void handleUpload()} disabled={uploadReceipt.isPending}>
            {uploadReceipt.isPending && <LoadingSpinner size="sm" className="mr-2 text-current" />}
            Upload
          </Button>
          <Button type="button" variant="outline" onClick={resetSelection} disabled={uploadReceipt.isPending}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
        <Upload className="mr-2 h-4 w-4" />
        Upload Receipt
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
      {validationError && <p className="text-sm text-destructive">{validationError}</p>}
    </div>
  );
}
