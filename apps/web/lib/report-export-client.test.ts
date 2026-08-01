import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExportRequestInput } from '@potato-corner/shared';

const { mockFetchAuthenticated } = vi.hoisted(() => ({
  mockFetchAuthenticated: vi.fn(),
}));

vi.mock('./api-client', () => ({
  fetchAuthenticated: mockFetchAuthenticated,
}));

import { requestReportExport, parseContentDisposition, isValidPdfSignature, ReportExportError } from './report-export-client';

const CSV_INPUT: ExportRequestInput = {
  report_type: 'DAILY_SALES',
  filters: { page: 1, limit: 25 },
  format: 'csv',
};

const PDF_INPUT: ExportRequestInput = {
  report_type: 'DAILY_SALES',
  filters: { page: 1, limit: 25 },
  format: 'pdf',
};

function fileResponse(opts: { status?: number; contentType: string; body: BlobPart[]; contentDisposition?: string }): Response {
  const blob = new Blob(opts.body, { type: opts.contentType });
  const headers = new Headers({ 'content-type': opts.contentType });
  if (opts.contentDisposition) headers.set('content-disposition', opts.contentDisposition);
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    blob: async () => blob,
    json: async () => {
      throw new Error('json() should not be called on a binary file response');
    },
    text: async () => '<binary>',
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    blob: async () => {
      throw new Error('blob() should not be called on a JSON response');
    },
  } as unknown as Response;
}

function htmlResponse(status: number, html: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
    text: async () => html,
    blob: async () => {
      throw new Error('blob() should not be called on an HTML response');
    },
  } as unknown as Response;
}

beforeEach(() => {
  mockFetchAuthenticated.mockReset();
});

describe('requestReportExport — CSV file branch', () => {
  it('reads a successful CSV response via .blob(), not .json()', async () => {
    mockFetchAuthenticated.mockResolvedValue(
      fileResponse({ contentType: 'text/csv; charset=utf-8', body: ['a,b,c\n1,2,3'], contentDisposition: 'attachment; filename="Daily_Sales.csv"' }),
    );

    const outcome = await requestReportExport(CSV_INPUT);

    expect(outcome.kind).toBe('file');
    if (outcome.kind === 'file') {
      expect(outcome.file.filename).toBe('Daily_Sales.csv');
      expect(outcome.file.size).toBeGreaterThan(0);
      expect(outcome.file.blob).toBeInstanceOf(Blob);
    }
  });

  it('uses the fallback filename when Content-Disposition is absent', async () => {
    mockFetchAuthenticated.mockResolvedValue(fileResponse({ contentType: 'text/csv', body: ['x'] }));

    const outcome = await requestReportExport(CSV_INPUT);

    expect(outcome.kind).toBe('file');
    if (outcome.kind === 'file') expect(outcome.file.filename).toBe('report_export.csv');
  });

  it('rejects an empty CSV blob', async () => {
    mockFetchAuthenticated.mockResolvedValue(fileResponse({ contentType: 'text/csv', body: [] }));

    await expect(requestReportExport(CSV_INPUT)).rejects.toThrow(ReportExportError);
  });
});

describe('requestReportExport — PDF file branch', () => {
  it('accepts a PDF response with a valid %PDF- signature', async () => {
    mockFetchAuthenticated.mockResolvedValue(
      fileResponse({ contentType: 'application/pdf', body: ['%PDF-1.4\n...'], contentDisposition: 'attachment; filename="Daily_Sales.pdf"' }),
    );

    const outcome = await requestReportExport(PDF_INPUT);

    expect(outcome.kind).toBe('file');
    if (outcome.kind === 'file') expect(outcome.file.mimeType).toContain('application/pdf');
  });

  it('rejects a PDF response with an invalid signature using the exact required message', async () => {
    mockFetchAuthenticated.mockResolvedValue(fileResponse({ contentType: 'application/pdf', body: ['not a real pdf'] }));

    await expect(requestReportExport(PDF_INPUT)).rejects.toThrow(
      'PDF export failed because the server did not return a valid PDF.',
    );
  });

  it('rejects a JSON "success" body masquerading as a PDF file result', async () => {
    // Caller expects format: 'pdf' but the response is JSON without a job_id shape — must fail safe, not be treated as a file.
    mockFetchAuthenticated.mockResolvedValue(jsonResponse(200, { data: { unexpected: true }, error: null, meta: null }));

    await expect(requestReportExport(PDF_INPUT)).rejects.toThrow(ReportExportError);
  });
});

describe('requestReportExport — async job branch', () => {
  it('treats an application/json 200 response as a job descriptor, never a download', async () => {
    mockFetchAuthenticated.mockResolvedValue(
      jsonResponse(200, { data: { job_id: 'job-123', message: 'Generating…', estimated_seconds: 30 }, error: null, meta: null }),
    );

    const outcome = await requestReportExport(CSV_INPUT);

    expect(outcome).toEqual({ kind: 'job', job_id: 'job-123', message: 'Generating…', estimated_seconds: 30 });
  });
});

describe('requestReportExport — HTML / gateway-error branch', () => {
  it('rejects a text/html 200 response instead of treating it as a successful download', async () => {
    mockFetchAuthenticated.mockResolvedValue(htmlResponse(200, '<html><body>Login</body></html>'));

    await expect(requestReportExport(CSV_INPUT)).rejects.toThrow(ReportExportError);
  });
});

describe('requestReportExport — error responses', () => {
  it('surfaces error.message from a non-2xx JSON error response', async () => {
    mockFetchAuthenticated.mockResolvedValue(jsonResponse(422, { data: null, error: { code: 'VALIDATION_ERROR', message: 'date_from is required' }, meta: null }));

    await expect(requestReportExport(CSV_INPUT)).rejects.toThrow('date_from is required');
  });

  it('falls back to error.code when message is absent on a non-2xx JSON error', async () => {
    mockFetchAuthenticated.mockResolvedValue(jsonResponse(403, { data: null, error: { code: 'FORBIDDEN' }, meta: null }));

    await expect(requestReportExport(CSV_INPUT)).rejects.toThrow('FORBIDDEN');
  });

  it('does not surface a raw HTML/text string from a non-2xx non-JSON error response', async () => {
    mockFetchAuthenticated.mockResolvedValue(htmlResponse(502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>'));

    await expect(requestReportExport(CSV_INPUT)).rejects.toThrow(ReportExportError);
    try {
      await requestReportExport(CSV_INPUT);
    } catch (err) {
      expect((err as Error).message).not.toContain('<html>');
      expect((err as Error).message).not.toContain('DOCTYPE');
    }
  });
});

describe('requestReportExport — wrong-format-for-content-type guard', () => {
  it('rejects when the response content-type does not match the requested format', async () => {
    // Asked for CSV, server returned something else entirely (not JSON, not HTML, not CSV).
    mockFetchAuthenticated.mockResolvedValue(fileResponse({ contentType: 'application/octet-stream', body: ['??'] }));

    await expect(requestReportExport(CSV_INPUT)).rejects.toThrow(ReportExportError);
  });
});

describe('parseContentDisposition', () => {
  it('parses the plain filename="X" form', () => {
    expect(parseContentDisposition('attachment; filename="Daily_Sales_2026-07-01_to_2026-07-31.csv"', 'fallback.csv')).toBe(
      'Daily_Sales_2026-07-01_to_2026-07-31.csv',
    );
  });

  it('parses the RFC 5987 filename*=UTF-8\'\' form', () => {
    expect(parseContentDisposition("attachment; filename*=UTF-8''Daily%20Sales.csv", 'fallback.csv')).toBe('Daily Sales.csv');
  });

  it('prefers the extended form when both are present', () => {
    expect(
      parseContentDisposition('attachment; filename="fallback-ascii.csv"; filename*=UTF-8\'\'Daily%20Sales.csv', 'fallback.csv'),
    ).toBe('Daily Sales.csv');
  });

  it('returns the fallback when the header is missing', () => {
    expect(parseContentDisposition(null, 'fallback.csv')).toBe('fallback.csv');
  });

  it('returns the fallback when the header is present but unparsable', () => {
    expect(parseContentDisposition('attachment', 'fallback.csv')).toBe('fallback.csv');
  });
});

describe('isValidPdfSignature', () => {
  it('accepts bytes starting with %PDF-', () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 rest of file');
    expect(isValidPdfSignature(bytes)).toBe(true);
  });

  it('rejects bytes that do not start with %PDF-', () => {
    const bytes = new TextEncoder().encode('not a pdf at all');
    expect(isValidPdfSignature(bytes)).toBe(false);
  });

  it('rejects a buffer shorter than the signature', () => {
    const bytes = new TextEncoder().encode('%PD');
    expect(isValidPdfSignature(bytes)).toBe(false);
  });
});
