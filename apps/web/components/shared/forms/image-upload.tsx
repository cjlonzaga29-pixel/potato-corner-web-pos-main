'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Camera, Check, ImageIcon, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type CaptureMode = 'live_capture' | 'gallery_upload';

interface ImageUploadProps {
  onImageSelected: (file: File, type: CaptureMode) => void;
  label?: string;
  required?: boolean;
}

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.8;

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

/** Supports live camera capture (getUserMedia) with a gallery-upload fallback when the camera is unavailable or fails. */
export function ImageUpload({ onImageSelected, label = 'Photo', required }: ImageUploadProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsCameraActive(false);
  }

  async function startCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setMode('live_capture');
      setIsCameraActive(true);
    } catch {
      setCameraError('Camera unavailable — use gallery upload instead.');
      setIsCameraActive(false);
    }
  }

  async function handleCapture() {
    if (!videoRef.current) return;
    const canvas = await drawToCanvas(videoRef.current);
    const blob = await compressCanvas(canvas);
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    stopCamera();
  }

  async function handleGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    const canvas = await drawToCanvas(selected);
    const blob = await compressCanvas(canvas);
    const file = new File([blob], selected.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
    setMode('gallery_upload');
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function handleRetake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPendingFile(null);
    setMode(null);
  }

  function handleConfirm() {
    if (pendingFile && mode) {
      onImageSelected(pendingFile, mode);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </p>

      {!previewUrl && !isCameraActive && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="touch-target flex-1" onClick={() => void startCamera()}>
            <Camera className="mr-2 h-4 w-4" />
            Take photo
          </Button>
          <Button
            type="button"
            variant="outline"
            className="touch-target flex-1"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageIcon className="mr-2 h-4 w-4" />
            Upload from gallery
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void handleGalleryChange(event)}
          />
        </div>
      )}

      {cameraError && <p className="text-sm text-destructive">{cameraError}</p>}

      {isCameraActive && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-red-500" />
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
            <span className={cn('h-2 w-2 rounded-full', mode === 'live_capture' ? 'bg-red-500' : 'bg-blue-500')} />
            {mode === 'live_capture' ? 'Live capture' : 'Gallery upload'}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
          <img src={previewUrl} alt="Preview" className="w-full rounded-md" />
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="touch-target flex-1" onClick={handleRetake}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Retake
            </Button>
            <Button type="button" className="touch-target flex-1" onClick={handleConfirm}>
              <Check className="mr-2 h-4 w-4" />
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
