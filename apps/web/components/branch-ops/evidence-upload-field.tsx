'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Loader2, RotateCcw, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUploadInventoryEvidence } from '@/hooks/queries/use-universal-inventory';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface EvidenceUploadFieldProps {
  branchId: string | null | undefined;
  label?: string;
  evidenceKey: string | null;
  onChange: (evidenceKey: string | null) => void;
}

/**
 * POS-PERF-P29 — unlike InventoryProofPhotoPicker (pick-only, uploads after
 * the movement/request already exists), this uploads the file IMMEDIATELY
 * on selection via the mandatory pre-submit /evidence endpoint, blocking
 * submit until an evidenceKey comes back. Failed uploads surface a Retry
 * action rather than silently leaving the form submittable without proof.
 */
export function EvidenceUploadField({ branchId, label = 'Proof Photo', evidenceKey, onChange }: EvidenceUploadFieldProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const upload = useUploadInventoryEvidence(branchId);

  async function uploadFile(selected: File) {
    setValidationError(null);
    setPendingFile(selected);
    try {
      const result = await upload.mutateAsync({ file: selected, proofType: 'gallery_upload' });
      onChange(result.evidence_key);
    } catch {
      onChange(null); // Upload failed — submit must stay blocked until a retry succeeds.
    }
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

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(selected));
    void uploadFile(selected);
  }

  function handleRemove() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPendingFile(null);
    setValidationError(null);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {label}
        <span className="ml-0.5 text-destructive">*</span>
      </p>
      {previewUrl ? (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
          <img src={previewUrl} alt="Proof preview" className="max-h-[160px] rounded-md border object-contain" />
          <div className="flex items-center gap-2">
            {upload.isPending && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
              </span>
            )}
            {!upload.isPending && evidenceKey && <span className="text-sm text-emerald-600">Uploaded</span>}
            {!upload.isPending && !evidenceKey && pendingFile && (
              <Button type="button" variant="outline" size="sm" onClick={() => void uploadFile(pendingFile)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Retry Upload
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={handleRemove}>
              <X className="mr-2 h-4 w-4" />
              Remove Photo
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-2 h-4 w-4" />
          Upload Photo
        </Button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />
      {validationError && <p className="text-sm text-destructive">{validationError}</p>}
    </div>
  );
}
