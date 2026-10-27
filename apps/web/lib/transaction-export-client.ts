import { apiClient, fetchAuthenticated } from '@/lib/api-client';
import { isValidPdfSignature, parseContentDisposition } from '@/lib/report-export-client';
import { triggerBrowserDownload } from '@/lib/trigger-download';

export class DownloadError extends Error {
  constructor(
    message: string,
    /** API error code when there was one, e.g. PROOF_FILE_MISSING. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface TransactionPdfFilters {
  transaction_id?: string;
  branch_id?: string;
  status?: string;
  payment_method?: string;
  date_from?: string;
  date_to?: string;
  receipt_search?: string;
}

/**
 * POS-PERF-P40 — GET /api/transactions/export/pdf. The server builds the PDF
 * from the filters (every matching row, not the visible page) or from one
 * transaction_id, and refuses oversized exports with a readable message.
 */
export async function downloadTransactionsPdf(filters: TransactionPdfFilters): Promise<string> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const response = await fetchAuthenticated(`/api/transactions/export/pdf?${params.toString()}`);
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok || !contentType.includes('application/pdf')) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } | string | null } | null;
    const error = body?.error;
    const message = typeof error === 'string' ? error : (error?.message ?? error?.code);
    throw new DownloadError(message ?? 'The PDF could not be generated. Please try again.');
  }

  const blob = await response.blob();
  const header = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (blob.size === 0 || !isValidPdfSignature(header)) throw new DownloadError('The server did not return a valid PDF.');

  const filename = parseContentDisposition(response.headers.get('content-disposition'), 'transactions.pdf');
  triggerBrowserDownload(blob, filename);
  return filename;
}

interface ProofDownloadResponse {
  download_url: string;
  filename: string;
  expires_in_seconds: number;
}

/**
 * POS-PERF-P40 — "Download Photo". Asks the API for a FRESH short-lived
 * signed URL on every click (so an expired link is never reused) whose
 * response carries Content-Disposition: attachment. Navigating to it saves
 * the file without leaving the page; nothing relies on the cross-origin
 * <a download> attribute, which browsers ignore. The bucket stays private
 * and the URL is never stored.
 */
export async function downloadProofPhoto(kind: 'payment' | 'discount', transactionId: string): Promise<string> {
  const response = await apiClient<ProofDownloadResponse>(`/api/transactions/${transactionId}/${kind}-proof?download=1`);
  if (!response.data) {
    const error = response.error;
    const message = typeof error === 'string' ? error : (error?.message ?? error?.code);
    throw new DownloadError(message ?? 'The photo could not be downloaded.', typeof error === 'string' ? undefined : error?.code);
  }
  // POS-PERF-P40R — Vercel ships this web build on push, before the API
  // deploy is approved. An older API ignores ?download=1 and answers with
  // the inline view URL, so there is no download_url; never navigate to
  // "undefined".
  if (typeof response.data.download_url !== 'string' || response.data.download_url === '') {
    throw new DownloadError('Download photo is not available until the server update finishes. Please try again later.');
  }
  const link = document.createElement('a');
  link.href = response.data.download_url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return response.data.filename;
}
