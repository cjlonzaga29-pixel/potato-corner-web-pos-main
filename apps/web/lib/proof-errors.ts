/**
 * POS-PERF-P40R — the API answers 410 PROOF_FILE_MISSING only after Storage
 * confirmed the object is gone from an existing bucket. That is permanent:
 * the viewer shows "Photo unavailable" and nothing retries it. Every other
 * proof failure stays retryable.
 */
export const PROOF_FILE_MISSING = 'PROOF_FILE_MISSING';

/** Works for TransactionApiError (view) and DownloadError (download), which both carry the API `code`. */
export function isProofFileMissing(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === PROOF_FILE_MISSING;
}
