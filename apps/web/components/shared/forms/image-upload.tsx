'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Camera, Check, ImageIcon, Loader2, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type CaptureMode = 'live_capture' | 'gallery_upload';

interface ImageUploadProps {
  /** May reject (e.g. the parent's network upload failing) — ImageUpload shows the failure inline with a Retry, keeping the captured/selected file so the cashier never has to recapture it. */
  onImageSelected: (file: File, type: CaptureMode) => Promise<void> | void;
  label?: string;
  description?: string;
  required?: boolean;
}

const JPEG_QUALITY = 0.8;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function validateFile(file: File): string | null {
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) return 'Only JPEG, PNG, or WebP images are supported.';
  if (file.size > MAX_FILE_SIZE_BYTES) return 'Image must be 5MB or smaller.';
  return null;
}

/**
 * Only used for the desktop getUserMedia path (handleCapturePhoto), which
 * has no other way to turn a <video> frame into a File. Mobile/tablet native
 * capture and gallery selection never touch a canvas or `createImageBitmap`
 * — the captured/selected File goes straight to upload. Decoding a
 * full-resolution phone photo into a bitmap + canvas backing store client
 * side is what produced "Unable to complete previous operation due to low
 * memory" on real Android devices; the server (multer + sharp, see
 * transactions.service.ts) already resizes/compresses every proof image, so
 * duplicating that work in the browser only cost memory for no benefit.
 */
function compressCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image compression failed'))), 'image/jpeg', JPEG_QUALITY);
  });
}

/**
 * Task 209.56E — "Take Photo" on mobile/tablet invokes the device's own
 * native camera capture UI via `<input type="file" capture="environment">`
 * rather than an in-page `getUserMedia()` live preview: the OS owns the
 * camera UI and the permission prompt there, the browser only ever receives
 * a finished file, and there is no stream to leak.
 *
 * Desktop/laptop browsers largely ignore `capture` and fall back to the OS
 * file picker instead of a camera — in practice that meant "Take Photo" on a
 * Windows/macOS cashier terminal opened the file picker, not the webcam.
 * Task 209.x reintroduces a `getUserMedia()` camera modal, but scoped to
 * desktop/laptop only (see `isMobileOrTablet` below), and specifically
 * guards the three failure modes that got the original in-page preview
 * pulled in 209.56E: every path that can end the capture (Capture, Cancel,
 * unmount, re-invoking Take Photo) routes through `stopCameraStream`, which
 * is idempotent and always runs before a new stream is requested — so there
 * is no code path that leaves a stream running (Task 209.16) or opens a
 * second one (Task 209.20). The modal is a dedicated `Dialog`, not embedded
 * in the checkout panel.
 *
 * "Upload from Gallery" stays a separate, `capture`-less file input so a
 * cashier can always pick an existing photo instead of taking a new one.
 */
type NavigatorWithUserAgentData = Navigator & { userAgentData?: { mobile?: boolean } };

/**
 * Deliberately not screen-width-based (a desktop window can be narrow, a
 * tablet can be wide). `userAgentData.mobile` is authoritative where present;
 * otherwise fall back to a UA sniff, plus an iPadOS-specific check since
 * iPadOS 13+ reports as "Macintosh" but — unlike a real Mac — exposes
 * multi-point touch.
 */
export function isMobileOrTablet(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as NavigatorWithUserAgentData).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function isGetUserMediaSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export function ImageUpload({ onImageSelected, label = 'Photo', description, required }: ImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(undefined);

  /** Idempotent — safe to call whether or not a stream is active. Every capture-ending path (Capture, Cancel, unmount, re-open) routes through this so a stream can never be left running or duplicated. */
  function stopCameraStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  // Ref (not the state value) so this unmount-only cleanup always reads the
  // latest preview URL rather than the one from whichever render registered
  // the effect — same pattern as terminal/page.tsx's own proof-preview
  // cleanup. Without this, closing checkout (or navigating away) while a
  // captured-but-not-yet-confirmed photo is showing left that object URL's
  // backing memory unreachable until the tab itself was closed.
  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = previewUrl;

  useEffect(() => {
    return () => {
      stopCameraStream();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  async function startCamera(deviceId?: string) {
    stopCameraStream();
    setCameraError(null);
    setIsStartingCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {
          // Autoplay can be rejected by browser policy even though the stream itself is valid — the <video> element still renders frames once srcObject is set.
        }
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setVideoDevices(devices.filter((device) => device.kind === 'videoinput'));
      } catch {
        // Device listing is a nice-to-have (camera switcher) — the preview above already works without it.
      }
    } catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
      setCameraError(
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Camera access was blocked. Allow camera permission in your browser or upload an image instead.'
          : 'Camera could not complete the photo capture. Please close other apps and try again, or use Upload from Gallery.',
      );
    } finally {
      setIsStartingCamera(false);
    }
  }

  function handleTakePhotoClick() {
    if (isCameraOpen) return;
    if (isMobileOrTablet()) {
      captureInputRef.current?.click();
      return;
    }
    if (!isGetUserMediaSupported()) {
      setCameraError('Camera is not available on this device/browser. Use Upload from Gallery.');
      return;
    }
    setCameraError(null);
    setIsCameraOpen(true);
    void startCamera(selectedDeviceId);
  }

  function handleCancelCamera() {
    stopCameraStream();
    setIsCameraOpen(false);
    setCameraError(null);
  }

  function handleSwitchCamera(deviceId: string) {
    setSelectedDeviceId(deviceId);
    void startCamera(deviceId);
  }

  async function handleCapturePhoto() {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await compressCanvas(canvas);
    const file = new File([blob], `camera-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    stopCameraStream();
    setIsCameraOpen(false);
    await loadSelectedFile(file, 'live_capture');
  }

  /**
   * No client-side decode/re-encode: the captured/selected File is validated
   * and handed straight to the caller's upload pipeline (FormData -> multer
   * -> sharp on the server). Mobile native camera photos can be large, but
   * decoding them into an ImageBitmap + canvas here — just to shrink them
   * before upload — is the exact client-side memory spike the server-side
   * sharp resize already makes unnecessary.
   *
   * That same decode still happened for the on-screen preview even after
   * 64a8165 removed the canvas re-encode: `URL.createObjectURL` is cheap,
   * but rendering it in an `<img>` forces the browser to decode the
   * full-resolution original to paint it, which is what kept reproducing
   * "Unable to complete previous operation due to low memory" on real
   * Android devices. Mobile/tablet skips that preview entirely — the
   * placeholder card below shows capture succeeded without ever decoding
   * the original. Desktop's getUserMedia path already captures at a much
   * smaller (webcam-native) resolution via compressCanvas, so it keeps the
   * direct preview.
   */
  function loadSelectedFile(selected: File, type: CaptureMode) {
    const validationMessage = validateFile(selected);
    if (validationMessage) {
      setValidationError(validationMessage);
      return;
    }
    setValidationError(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return isMobileOrTablet() ? null : URL.createObjectURL(selected);
    });
    setMode(type);
    setPendingFile(selected);
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

      {!pendingFile && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="touch-target flex-1" onClick={handleTakePhotoClick}>
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

      {!isCameraOpen && cameraError && (
        <Alert variant="destructive" className="px-3 py-2">
          <AlertDescription>{cameraError}</AlertDescription>
        </Alert>
      )}

      <Dialog open={isCameraOpen} onOpenChange={(open) => !open && handleCancelCamera()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Take Photo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {cameraError && (
              <Alert variant="destructive" className="px-3 py-2">
                <AlertDescription>{cameraError}</AlertDescription>
              </Alert>
            )}
            <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
              <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
              {isStartingCamera && (
                <div className="absolute inset-0 flex items-center justify-center text-white">
                  <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
                </div>
              )}
            </div>
            {videoDevices.length > 1 && (
              <select
                value={selectedDeviceId ?? ''}
                onChange={(event) => handleSwitchCamera(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label="Select camera"
              >
                {videoDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancelCamera}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCapturePhoto()} disabled={!streamRef.current || isStartingCamera}>
              <Camera className="mr-2 h-4 w-4" />
              Capture Photo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pendingFile && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', mode === 'live_capture' ? 'bg-destructive' : 'bg-info')} />
            {mode === 'live_capture' ? 'Photo captured' : 'Gallery upload'}
          </div>
          {previewUrl ? (
            /* Compact thumbnail only — the live camera preview above (if any)
               is torn down before this state renders. Capped via the same
               density-aware token the old live preview used, kept here so
               this pending-confirm state can never grow past what a checkout
               footer can spare at any density tier. */
            /* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */
            <img src={previewUrl} alt="Preview" className="app-pos-proof-preview-height w-full rounded-md" />
          ) : (
            // Mobile/tablet: no preview image — see loadSelectedFile above for why.
            <div className="app-pos-proof-preview-height flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-xs text-muted-foreground">
              <ImageIcon className="h-6 w-6" aria-hidden="true" />
              <span>Photo captured — ready to upload ({(pendingFile.size / (1024 * 1024)).toFixed(1)} MB)</span>
            </div>
          )}

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
