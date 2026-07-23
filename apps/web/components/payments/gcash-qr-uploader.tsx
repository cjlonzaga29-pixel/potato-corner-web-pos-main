'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface GcashQrUploaderProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
}

/** Single-file drag/drop or click uploader for the GCash QR image, with an inline preview. */
export function GcashQrUploader({ file, onFileChange, disabled }: GcashQrUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function validateAndSet(candidate: File | undefined) {
    if (!candidate) return;
    if (!ACCEPTED_TYPES.includes(candidate.type)) {
      setError('Image must be JPEG, PNG, or WebP');
      return;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      setError('Image must be 5MB or smaller');
      return;
    }
    setError(null);
    onFileChange(candidate);
  }

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload GCash QR image"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (!disabled) validateAndSet(event.dataTransfer.files[0]);
        }}
        className={cn(
          'flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors',
          isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset
          <img src={previewUrl} alt="QR preview" className="h-32 w-32 rounded-md border object-contain" />
        ) : (
          <>
            <ImagePlus className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Click or drag a QR image here (JPEG, PNG, or WebP, max 5MB)</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            validateAndSet(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>

      {file && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{file.name}</span>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onFileChange(null)} className="shrink-0">
            <X className="mr-1 h-3 w-3" />
            Remove
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
