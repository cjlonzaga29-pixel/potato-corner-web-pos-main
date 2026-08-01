import type { ExportRequestInput } from '@potato-corner/shared';
import { fetchAuthenticated } from './api-client';

export interface DownloadedExportFile {
  blob: Blob;
  filename: string;
  mimeType: string;
  size: number;
}

export type ExportOutcome =
  | { kind: 'file'; file: DownloadedExportFile }
  | { kind: 'job'; job_id: string; message: string; estimated_seconds: number };

export class ReportExportError extends Error {}

const MIME_BY_FORMAT: Record<ExportRequestInput['format'], string> = {
  csv: 'text/csv',
  pdf: 'application/pdf',
};

const FALLBACK_FILENAME_BY_FORMAT: Record<ExportRequestInput['format'], string> = {
  csv: 'report_export.csv',
  pdf: 'report_export.pdf',
};

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * Extracts a filename from a Content-Disposition header, supporting both the
 * plain `filename="X"` form and the RFC 5987 extended `filename*=UTF-8''X`
 * form (preferred when both are present, since it's the one that survives
 * non-ASCII names). Falls back to `fallback` when the header is missing or
 * neither form can be parsed.
 */
export function parseContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  const extendedMatch = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (extendedMatch?.[1]) {
    try {
      return decodeURIComponent(extendedMatch[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain form/fallback.
    }
  }

  const plainMatch = header.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  const plainValue = plainMatch?.[1] ?? plainMatch?.[2];
  if (plainValue) return plainValue.trim();

  return fallback;
}

/** Checks the first bytes of a would-be PDF blob against the "%PDF-" magic number. */
export function isValidPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_SIGNATURE.length) return false;
  return PDF_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/**
 * Reads a Blob's leading bytes via FileReader rather than Blob.arrayBuffer()/
 * text() — those are unimplemented on the Blob polyfill this runs under in
 * jsdom (only .slice()/.size/.type exist there), while FileReader is fully
 * implemented in both jsdom and every real browser this app targets.
 */
function readBlobHeaderBytes(blob: Blob, byteCount: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // FileReader.result is typed string | ArrayBuffer | null regardless of
    // which read method was called — readAsArrayBuffer always resolves an
    // ArrayBuffer (or null before load), never a string.
    reader.onload = () => resolve(new Uint8Array((reader.result as ArrayBuffer | null) ?? new ArrayBuffer(0)));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read report file'));
    reader.readAsArrayBuffer(blob.slice(0, byteCount));
  });
}

interface JsonErrorBody {
  data: null;
  error: { code: string; message?: string } | string | null;
  meta: null;
}

function errorMessageFrom(body: JsonErrorBody | null, fallback: string): string {
  if (!body?.error) return fallback;
  return typeof body.error === 'string' ? body.error : (body.error.message ?? body.error.code ?? fallback);
}

/**
 * Binary-safe client for POST /api/reports/export. Unlike apiClient(), this
 * never blindly calls response.json() — a successful CSV/PDF export returns
 * raw file bytes, not a JSON envelope, and calling .json() on it would either
 * throw or (worse) silently misparse binary data.
 *
 * See the module-level contract in the accompanying task spec: normal-sized
 * exports return the file directly (200, real Content-Type, Content-
 * Disposition); oversized reports return a 200 JSON job descriptor instead
 * (the existing async/socket.io flow finishes those); anything else is an
 * error to report back to the user, never a "successful" download.
 */
export async function requestReportExport(input: ExportRequestInput): Promise<ExportOutcome> {
  const response = await fetchAuthenticated('/api/reports/export', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const body = (await response.json().catch(() => null)) as JsonErrorBody | null;
      throw new ReportExportError(errorMessageFrom(body, 'Failed to request report export.'));
    }
    // Never hand raw HTML/text back to the UI — read it defensively for
    // logging purposes only, and surface a generic, safe message.
    await response.text().catch(() => '');
    throw new ReportExportError('Failed to request report export. Please try again.');
  }

  if (contentType.includes('application/json')) {
    // The async/oversized-report branch — no file exists yet, a background
    // job will produce one and notify via useReportsRealtimeSync.
    const body = (await response.json().catch(() => null)) as { data?: { job_id?: string; message?: string; estimated_seconds?: number } } | null;
    const jobId = body?.data?.job_id;
    if (!jobId) {
      throw new ReportExportError('The server did not return a valid export job.');
    }
    return {
      kind: 'job',
      job_id: jobId,
      message: body?.data?.message ?? "Generating your report… you'll be notified when it's ready.",
      estimated_seconds: body?.data?.estimated_seconds ?? 0,
    };
  }

  if (contentType.includes('text/html')) {
    throw new ReportExportError('The server returned an unexpected response instead of the report file.');
  }

  const expectedMime = MIME_BY_FORMAT[input.format];
  if (!contentType.includes(expectedMime)) {
    throw new ReportExportError(`The server did not return a valid ${input.format.toUpperCase()} file.`);
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new ReportExportError(`${input.format.toUpperCase()} export failed because the server returned an empty file.`);
  }

  if (input.format === 'pdf') {
    const headerBytes = await readBlobHeaderBytes(blob, PDF_SIGNATURE.length);
    if (!isValidPdfSignature(headerBytes)) {
      throw new ReportExportError('PDF export failed because the server did not return a valid PDF.');
    }
  }

  const filename = parseContentDisposition(response.headers.get('content-disposition'), FALLBACK_FILENAME_BY_FORMAT[input.format]);

  return {
    kind: 'file',
    file: { blob, filename, mimeType: contentType, size: blob.size },
  };
}
