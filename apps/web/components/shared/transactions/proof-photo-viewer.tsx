'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { downloadProofPhoto } from '@/lib/transaction-export-client';
import { isProofFileMissing } from '@/lib/proof-errors';
import { formatManilaDateTime } from '@/lib/manila-date';

const CAPTURE_MODE_LABEL: Record<string, string> = {
  live_capture: 'Live camera capture',
  gallery_upload: 'Gallery upload',
};

interface ProofPhotoViewerProps {
  kind: 'payment' | 'discount';
  transactionId: string;
  /** Signed view URL from the query; null when no photo was captured. */
  url: string | null | undefined;
  captureType: string | null | undefined;
  uploadedAt: string | null | undefined;
  isLoading: boolean;
  isError: boolean;
  /** POS-PERF-P40R — the API confirmed the file is gone from storage (410 PROOF_FILE_MISSING); retrying cannot help. */
  isMissing?: boolean;
  /** Re-fetches a fresh signed view URL (used after a load failure, e.g. an expired link). */
  onReload: () => void;
}

function PhotoUnavailable({ label }: { label: string }) {
  return (
    <div className="space-y-1 rounded-md border border-dashed p-4 text-sm" role="status">
      <p className="font-medium">Photo unavailable</p>
      <p className="text-muted-foreground">
        The {label} was recorded for this transaction, but the photo file is no longer in storage, so it can&apos;t be shown or
        downloaded. Trying again won&apos;t bring it back.
      </p>
    </div>
  );
}

/**
 * POS-PERF-P40 — shared body of the Payment/Discount proof dialogs. The
 * inline image uses a short-lived signed URL; if it fails to load (most
 * often because the link expired while the dialog sat open) the viewer
 * offers "Reload photo", which asks the API for a fresh one. "Download
 * photo" always requests its own fresh attachment URL.
 */
export function ProofPhotoViewer({ kind, transactionId, url, captureType, uploadedAt, isLoading, isError, isMissing = false, onReload }: ProofPhotoViewerProps) {
  const label = kind === 'payment' ? 'payment proof' : 'discount proof';
  const [imageFailed, setImageFailed] = useState(false);
  const [downloadState, setDownloadState] = useState<{ status: 'idle' | 'working' | 'error' | 'missing' | 'done'; message?: string }>({ status: 'idle' });

  // A new signed URL is a new attempt.
  useEffect(() => setImageFailed(false), [url]);

  async function handleDownload() {
    setDownloadState({ status: 'working' });
    try {
      const filename = await downloadProofPhoto(kind, transactionId);
      setDownloadState({ status: 'done', message: `Downloading ${filename}` });
    } catch (error) {
      if (isProofFileMissing(error)) {
        setDownloadState({ status: 'missing' });
        return;
      }
      setDownloadState({ status: 'error', message: error instanceof Error ? error.message : 'The photo could not be downloaded.' });
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-8" aria-busy="true" aria-label={`Loading ${label}`}>
        <LoadingSpinner />
      </div>
    );
  }

  if (isMissing || downloadState.status === 'missing') {
    return <PhotoUnavailable label={label} />;
  }

  if (isError) {
    return (
      <div className="space-y-2 py-4" role="alert">
        <p className="text-sm text-destructive">Failed to load the {label}.</p>
        <Button variant="outline" size="sm" onClick={onReload}>
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Try again
        </Button>
      </div>
    );
  }

  if (!url) {
    return <p className="py-4 text-sm text-muted-foreground">No {label} was captured for this transaction.</p>;
  }

  return (
    <div className="space-y-3">
      {imageFailed ? (
        <div className="space-y-2 rounded-md border border-dashed p-4 text-sm" role="alert">
          <p>The photo didn&apos;t load. The secure link may have expired, or the photo is no longer available in storage.</p>
          <Button variant="outline" size="sm" onClick={onReload}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Reload photo
          </Button>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not an optimizable local asset
        <img src={url} alt={kind === 'payment' ? 'Payment proof' : 'Discount proof'} className="w-full rounded-md border" onError={() => setImageFailed(true)} />
      )}
      <p className="text-xs text-muted-foreground">
        {captureType ? CAPTURE_MODE_LABEL[captureType] : ''}
        {uploadedAt ? ` · ${formatManilaDateTime(uploadedAt)}` : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void handleDownload()} disabled={downloadState.status === 'working'}>
          {downloadState.status === 'working' ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
          )}
          Download photo
        </Button>
        <span className="text-xs" role="status" aria-live="polite">
          {downloadState.status === 'error' ? <span className="text-destructive">{downloadState.message} Try again.</span> : (downloadState.message ?? '')}
        </span>
      </div>
    </div>
  );
}
