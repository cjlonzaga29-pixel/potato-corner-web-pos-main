'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Camera, Check, ImageIcon, Loader2, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type CaptureMode = 'live_capture' | 'gallery_upload';

interface ImageUploadProps {
  /** May reject (e.g. the parent's network upload failing) — ImageUpload shows the failure inline with a Retry, keeping the captured/selected file so the cashier never has to recapture it. */
  onImageSelected: (file: File, type: CaptureMode) => Promise<void> | void;
  label?: string;
  description?: string;
  required?: boolean;
}

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.8;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function validateFile(file: File): string | null {
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) return 'Only JPEG, PNG, or WebP images are supported.';
  if (file.size > MAX_FILE_SIZE_BYTES) return 'Image must be 5MB or smaller.';
  return null;
}

function compressCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image compression failed'))), 'image/jpeg', JPEG_QUALITY);
  });
}

/** Downscales to MAX_DIMENSION on the long edge before re-encoding as JPEG — keeps clock-in/ID/proof photos small before upload. */
async function drawToCanvas(source: ImageBitmapSource): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Task 209.56E — "Take Photo" invokes the device's own native camera capture
 * UI via `<input type="file" capture="environment">` instead of an in-page
 * `getUserMedia()` live preview. This replaced an earlier implementation
 * that opened a large embedded `<video>` preview inside the checkout modal
 * (owner-reported "Live capture" complaint) and that carried real recurring
 * cost: getUserMedia needs explicit permission handling, stream cleanup on
 * unmount/modal-close (a camera left running was a shipped bug — Task
 * 209.16), and per-browser quirks (Task 209.18's black-preview regression,
 * Task 209.20's oversized preview). The native `capture` attribute has none
 * of that: the OS owns the camera UI and the permission prompt, the browser
 * only ever receives a finished file, and there is no stream to leak.
 *
 * `capture="environment"` is honored by mobile/tablet browsers (opens the
 * rear camera directly); desktop browsers that don't support `capture`
 * silently ignore it and fall back to their normal OS file picker — most
 * desktop OS file pickers (Windows, macOS) offer their own "camera" option
 * inside that picker, so a desktop cashier terminal still has a working
 * capture path, just via the OS chrome instead of an in-page one. This is
 * the graceful degradation the spec provides for a `capture` attribute an
 * engine doesn't support — no feature-detection branch is needed for it,
 * unlike getUserMedia's own must-detect-and-fall-back-in-JS story.
 *
 * "Upload from Gallery" stays a separate, `capture`-less file input so a
 * cashier can always pick an existing photo instead of taking a new one.
 */
export function ImageUpload({ onImageSelected, label = 'Photo', description, required }: ImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function loadSelectedFile(selected: File, type: CaptureMode) {
    const validationMessage = validateFile(selected);
    if (validationMessage) {
      setValidationError(validationMessage);
      return;
    }
    setValidationError(null);
    try {
      const canvas = await drawToCanvas(selected);
      const blob = await compressCanvas(canvas);
      const file = new File([blob], selected.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
      setMode(type);
      setPendingFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    } catch {
      setValidationError('Could not read that image — try a different file.');
    }
  }

  async function handleGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    await loadSelectedFile(selected, 'gallery_upload');
  }

  async function handleCaptureChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    // A photo taken via the native camera UI is still a live capture from
    // the cashier's point of view, even though it arrives here as a file.
    await loadSelectedFile(selected, 'live_capture');
  }

  function handleRetake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPendingFile(null);
    setMode(null);
    setUploadError(null);
  }

  function handleRemove() {
    handleRetake();
    setValidationError(null);
  }

  async function handleConfirm() {
    if (!pendingFile || !mode || isUploading) return;
    setUploadError(null);
    setIsUploading(true);
    try {
      await onImageSelected(pendingFile, mode);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed — check your connection and try again.');
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Camera className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>

      {!previewUrl && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="touch-target flex-1" onClick={() => captureInputRef.current?.click()}>
            <Camera className="mr-2 h-4 w-4" />
            Take Photo
          </Button>
          <Button
            type="button"
            variant="outline"
            className="touch-target flex-1"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageIcon className="mr-2 h-4 w-4" />
            Upload from Gallery
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => void handleGalleryChange(event)}
          />
          {/* Task 209.56E follow-up — a real-device test found this input opening
              the gallery/library instead of the camera on several Android
              browsers. The narrow, comma-separated `accept` list (matching
              the gallery input above) is the cause: many Android WebView/
              Chrome builds only reliably honor `capture` when `accept` is the
              broad `image/*` wildcard — a specific MIME list makes them fall
              back to the general file/library chooser instead of launching
              the camera app. `accept="image/*"` here is not a security
              relaxation: validateFile() re-checks the actual selected file's
              type against ACCEPTED_MIME_TYPES regardless of what this
              attribute let through, exactly as it already did before this
              change. */}
          <input
            ref={captureInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => void handleCaptureChange(event)}
          />
        </div>
      )}

      {validationError && (
        <Alert variant="destructive" className="px-3 py-2">
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {previewUrl && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', mode === 'live_capture' ? 'bg-destructive' : 'bg-info')} />
            {mode === 'live_capture' ? 'Photo captured' : 'Gallery upload'}
          </div>
          {/* Compact thumbnail only — no permanent/embedded camera preview.
              Capped via the same density-aware token the old live preview
              used, kept here so this pending-confirm state can never grow
              past what a checkout footer can spare at any density tier. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
          <img src={previewUrl} alt="Preview" className="app-pos-proof-preview-height w-full rounded-md" />

          {uploadError && (
            <Alert variant="destructive" className="px-3 py-2">
              <AlertDescription>{uploadError}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button type="button" variant="outline" className="touch-target flex-1" onClick={handleRetake} disabled={isUploading}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Retake
            </Button>
            <Button type="button" variant="outline" className="touch-target" onClick={handleRemove} disabled={isUploading}>
              <X className="mr-2 h-4 w-4" />
              Remove
            </Button>
            <Button type="button" className="touch-target flex-1" onClick={() => void handleConfirm()} disabled={isUploading}>
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Uploading…
                </>
              ) : uploadError ? (
                'Retry Upload'
              ) : (
                <>
                  <Check className="mr-2 h-4 w-4" />
                  Confirm
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
