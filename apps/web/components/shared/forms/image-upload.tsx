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
/** Long-edge cap for the in-page camera's captured frame. Proof photos only need to be legible (PWD/Senior ID, GCash/Maya reference), not archival quality — this is what keeps a captured JPEG in the hundreds-of-KB range instead of the multi-MB/low-memory-crash originals the old native-camera flow produced. */
const MAX_CAPTURE_DIMENSION = 1600;
/** Bounded getUserMedia request — deliberately NOT the device's maximum native resolution, which is what caused "Unable to complete previous operation due to low memory" on real Android devices. */
const CAMERA_VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 } } as const;

function validateFile(file: File): string | null {
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) return 'Only JPEG, PNG, or WebP images are supported.';
  if (file.size > MAX_FILE_SIZE_BYTES) return 'Image must be 5MB or smaller.';
  return null;
}

/** Only path that ever touches a canvas — the bounded getUserMedia capture frame. Gallery selection and the native-camera fallback (only reachable when getUserMedia is unsupported) hand their File straight to upload with no client-side decode; the server (multer + sharp, see transactions.service.ts) already resizes/compresses every proof image. */
function compressCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image compression failed'))), 'image/jpeg', JPEG_QUALITY);
  });
}

/**
 * OWNER REQUIREMENT (emergency in-POS mobile camera fix): "Take Photo" must
 * never leave the POS page. It previously invoked the device's native camera
 * app via `<input type="file" capture="environment">` on mobile/tablet —
 * the OS owned the camera UI, but backgrounding the browser tab to run that
 * native app is exactly what real Android devices were killing/reloading
 * under memory pressure ("Unable to complete previous operation due to low
 * memory"), which also unmounted the in-progress checkout. `getUserMedia()`
 * now runs on mobile and desktop alike, in a `Dialog` overlay stacked above
 * the still-mounted checkout — the tab never loses focus and no navigation
 * ever occurs. Every path that can end the capture (Capture, Cancel,
 * Android back button, unmount, re-invoking Take Photo) routes through
 * `stopCameraStream`, which is idempotent and always runs before a new
 * stream is requested — so there is no code path that leaves a stream
 * running or opens a second one.
 *
 * The native `capture="environment"` input is kept only as a fallback for
 * the rare mobile browser without `getUserMedia` support — never the
 * default path anymore. "Upload from Gallery" stays a separate,
 * `capture`-less file input so a cashier can always pick an existing photo.
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

  // Owner requirement: Android hardware/gesture Back while the camera
  // overlay is open must close the overlay and return to checkout — never
  // leave the POS page. Without a pushed history entry, Back falls through
  // to the browser's real navigation stack (the previous route, or out of
  // the app). `closingByUsRef` distinguishes "user pressed Back" (browser
  // already consumed our pushed entry, nothing left to undo) from "user hit
  // Cancel/Capture" (we must consume the entry ourselves via history.back()
  // so a later real Back press doesn't hit our stale marker).
  const closingByUsRef = useRef(false);
  useEffect(() => {
    if (!isCameraOpen) return;
    window.history.pushState({ cameraOverlay: true }, '');
    function handlePopState() {
      closingByUsRef.current = true;
      stopCameraStream();
      setIsCameraOpen(false);
      setCameraError(null);
    }
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (closingByUsRef.current) {
        closingByUsRef.current = false;
      } else {
        window.history.back();
      }
    };
  }, [isCameraOpen]);

  async function startCamera(deviceId?: string) {
    stopCameraStream();
    setCameraError(null);
    setIsStartingCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId }, ...CAMERA_VIDEO_CONSTRAINTS } : { facingMode: { ideal: 'environment' }, ...CAMERA_VIDEO_CONSTRAINTS },
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
    if (!isGetUserMediaSupported()) {
      // Fallback only (item 16/19): the rare mobile browser without
      // getUserMedia still gets a working camera via the native capture
      // input; desktop/laptop has no native-camera analog, so it falls back
      // to the error message + Upload from Gallery instead.
      if (isMobileOrTablet()) {
        captureInputRef.current?.click();
        return;
      }
      setCameraError('Camera is not available in this browser. Use Upload from Gallery.');
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

  /** Single frame, single canvas, single Blob — clamped to MAX_CAPTURE_DIMENSION on the long edge even though the getUserMedia request above already asks for a bounded resolution, because `ideal` is a soft constraint some devices/cameras don't honor exactly. */
  async function handleCapturePhoto() {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await compressCanvas(canvas);
    const file = new File([blob], `camera-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    // Camera indicator must turn off immediately — before upload, not after.
    stopCameraStream();
    setIsCameraOpen(false);
    loadSelectedFile(file, 'live_capture', { bounded: true });
  }

  /**
   * No client-side decode/re-encode for gallery selection or the native-
   * camera fallback: the File is validated and handed straight to the
   * caller's upload pipeline (FormData -> multer -> sharp on the server).
   * The in-page camera capture above is the one path that already produced
   * a small, bounded-resolution JPEG (MAX_CAPTURE_DIMENSION) — safe to
   * preview directly. Gallery picks and the rare native-capture fallback can
   * still be an unbounded, full-resolution phone photo; decoding one of
   * those into an `<img>` preview is what reproduced "Unable to complete
   * previous operation due to low memory" on real Android devices, so those
   * two paths keep skipping the preview on mobile/tablet.
   */
  function loadSelectedFile(selected: File, type: CaptureMode, options?: { bounded?: boolean }) {
    const validationMessage = validateFile(selected);
    if (validationMessage) {
      setValidationError(validationMessage);
      return;
    }
    setValidationError(null);
    const skipPreview = isMobileOrTablet() && !options?.bounded;
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return skipPreview ? null : URL.createObjectURL(selected);
    });
    setMode(type);
    setPendingFile(selected);
  }

  function handleGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    loadSelectedFile(selected, 'gallery_upload');
  }

  function handleCaptureChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    // A photo taken via the native camera UI is still a live capture from
    // the cashier's point of view, even though it arrives here as a file.
    loadSelectedFile(selected, 'live_capture');
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
