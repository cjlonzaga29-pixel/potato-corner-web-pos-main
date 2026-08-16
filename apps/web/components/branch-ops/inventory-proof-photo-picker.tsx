'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface InventoryProofPhotoPickerProps {
  label?: string;
  file: File | null;
  onChange: (file: File | null) => void;
}

/**
 * Pure client-side pick/preview — never uploads itself. Receiving/waste
 * movements don't exist yet while the form is being filled out (Receiving
 * Simplification V2 §7-8's two-step upload needs a movement id), so the
 * caller uploads the picked file via useUploadMovementProof only after the
 * movement is created on submit. Mirrors ExpenseReceiptUpload's validation
 * rules (5MB cap, JPEG/PNG/WebP) without its "already has an id" upload step.
 */
export function InventoryProofPhotoPicker({ label = 'Receipt / Delivery Proof', file, onChange }: InventoryProofPhotoPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

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
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(selected));
    onChange(selected);
  }

  function handleRemove() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setValidationError(null);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      {file && previewUrl ? (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
          <img src={previewUrl} alt="Proof preview" className="max-h-[160px] rounded-md border object-contain" />
          <Button type="button" variant="outline" size="sm" onClick={handleRemove}>
            <X className="mr-2 h-4 w-4" />
            Remove Photo
          </Button>
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
