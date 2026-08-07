'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Camera, Check, ImageIcon, Loader2, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type CaptureMode = 'live_capture' | 'gallery_upload';
type CameraStatus = 'idle' | 'active' | 'permission_denied' | 'unsupported';

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

function hasCameraSupport(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

function compressCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image compression failed'))), 'image/jpeg', JPEG_QUALITY);
  });
}

/** Downscales to MAX_DIMENSION on the long edge before re-encoding as JPEG — keeps clock-in/ID photos small before upload. */
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
 * Capture priority, matched to what's actually available in the browser:
 *   1. getUserMedia() — in-page live preview + Capture button.
 *   2. capture="environment" on a file input — opens the device's native
 *      camera app directly where the browser supports it.
 *   3. Plain file input — the same element degrades to an ordinary file/
 *      gallery picker where `capture` isn't supported, so tier 2 and 3 are
 *      really one control.
 * "Upload from Gallery" is always offered as an explicit, separate action
 * (no `capture` attribute) so a cashier can pick an existing screenshot
 * instead of taking a new photo.
 */
export function ImageUpload({ onImageSelected, label = 'Photo', description, required }: ImageUploadProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureFallbackRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsCameraActive(false);
  }

  async function startCamera() {
    setCameraError(null);
    setValidationError(null);

    if (cameraStatus === 'permission_denied' || cameraStatus === 'unsupported' || !hasCameraSupport()) {
      // Already known bad (or never supported) — go straight to the
      // capture="environment"/gallery fallback instead of re-prompting.
      if (cameraStatus === 'permission_denied') {
        setCameraError('Camera permission denied — switching to the fallback camera/upload picker.');
      } else {
        setCameraStatus('unsupported');
        setCameraError('Camera not supported on this device or browser — switching to the fallback camera/upload picker.');
      }
      captureFallbackRef.current?.click();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setMode('live_capture');
      setIsCameraActive(true);
      setCameraStatus('active');
    } catch (error) {
      setIsCameraActive(false);
      // getUserMedia rejects with a DOMException, which per spec does NOT
      // extend Error (unlike a typical thrown error) — `instanceof Error`
      // would silently misclassify every permission-denied rejection as
      // "unsupported" here, so read `.name` structurally instead.
      const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        setCameraStatus('permission_denied');
        setCameraError('Camera permission denied — switching to the fallback camera/upload picker.');
      } else {
        setCameraStatus('unsupported');
        setCameraError('Camera not supported on this device or browser — switching to the fallback camera/upload picker.');
      }
      captureFallbackRef.current?.click();
    }
  }

  async function handleCapture() {
    if (!videoRef.current) return;
    try {
      const canvas = await drawToCanvas(videoRef.current);
      const blob = await compressCanvas(canvas);
      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setPendingFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      stopCamera();
    } catch {
      setCameraError('Could not capture that frame — try again.');
    }
  }

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

  async function handleCaptureFallbackChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    // A photo taken via the native camera app is still a live capture from
    // the cashier's point of view, even though it arrived as a file.
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
    setCameraError(null);
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

      {!previewUrl && !isCameraActive && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="touch-target flex-1" onClick={() => void startCamera()}>
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
          {/* Tier 2/3 fallback for Take Photo: opens the native camera where
              `capture` is supported, otherwise degrades to a plain file picker. */}
          <input
            ref={captureFallbackRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={(event) => void handleCaptureFallbackChange(event)}
          />
        </div>
      )}

      {cameraError && (
        <Alert variant="destructive" className="px-3 py-2">
          <AlertDescription>{cameraError}</AlertDescription>
        </Alert>
      )}

      {validationError && (
        <Alert variant="destructive" className="px-3 py-2">
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {isCameraActive && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-destructive" />
            Live capture
          </div>
          <video ref={videoRef} className="w-full rounded-md bg-black" muted playsInline />
          <div className="flex gap-2">
            <Button type="button" className="touch-target flex-1" onClick={() => void handleCapture()}>
              Capture
            </Button>
            <Button type="button" variant="outline" className="touch-target" onClick={stopCamera}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {previewUrl && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', mode === 'live_capture' ? 'bg-destructive' : 'bg-info')} />
            {mode === 'live_capture' ? 'Live capture' : 'Gallery upload'}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
          <img src={previewUrl} alt="Preview" className="w-full rounded-md" />

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
