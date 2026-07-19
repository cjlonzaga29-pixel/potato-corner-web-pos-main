import * as Sentry from '@sentry/node';
import { randomUUID } from 'node:crypto';
import { SOCKET_EVENTS, type ReportType } from '@potato-corner/shared';
import { runFireAndForget, runWithRetry } from '../lib/job-runner.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { notifyUser } from '../lib/notify.js';
import { generateCsv } from '../lib/reports/csv.js';
import { generatePdf } from '../lib/reports/pdf.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { prisma } from '../lib/prisma.js';
import { reportsRepository } from '../modules/reports/reports.repository.js';
import { getReportRows, REPORT_COLUMNS } from '../modules/reports/reports.columns.js';
import type { ReportFilters } from '../modules/reports/reports.types.js';

/**
 * Phase 21: BullMQ removed — see lib/job-runner.ts. RETRY_DELAYS_MS below
 * preserves the architecture spec's 10s/60s/300s schedule (Architecture doc
 * §3.6) for generate_export; refresh_snapshot keeps its original
 * `attempts: 1` (no retry).
 */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

export interface GenerateExportJobData {
  reportType: ReportType;
  filters: ReportFilters;
  format: 'csv' | 'pdf';
  requesterId: string;
  branchId: string | null;
}

export interface RefreshSnapshotJobData {
  reportType: ReportType;
  branchId: string | null;
  filters: ReportFilters;
}

/**
 * Enqueues an async export job (large CSV or any PDF, Task 12). Runs in the
 * background with Decision 7's retry policy; returns immediately.
 */
export function enqueueGenerateExport(data: GenerateExportJobData): Promise<{ id: string }> {
  const jobId = randomUUID();
  runFireAndForget(
    () => runWithRetry(() => processGenerateExport(jobId, data), RETRY_DELAYS_MS),
    (error) => handleGenerateExportFailure(jobId, data, error, MAX_ATTEMPTS),
  );
  return Promise.resolve({ id: jobId });
}

/**
 * Enqueues a background recompute of a pre-computed report snapshot
 * (Task 11's stale-while-revalidate path). Fire-and-forget from the
 * caller's perspective — the request already served the stale snapshot.
 * No retry (matches the old `attempts: 1`).
 */
export function enqueueRefreshSnapshot(data: RefreshSnapshotJobData): Promise<{ id: string }> {
  const jobId = randomUUID();
  runFireAndForget(
    () => processRefreshSnapshot(data),
    (error) => console.error('Report snapshot refresh failed:', error),
  );
  return Promise.resolve({ id: jobId });
}

export async function processGenerateExport(jobId: string, data: GenerateExportJobData): Promise<void> {
  const { reportType, filters, format, requesterId, branchId } = data;
  const rows = await getReportRows(reportType, filters);
  const columns = REPORT_COLUMNS[reportType];
  const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;

  const buffer = format === 'csv' ? generateCsv(rows, columns) : await generatePdf(reportType, filters, rows, columns, branch?.name ?? null);
  const extension = format === 'csv' ? 'csv' : 'pdf';
  const contentType = format === 'csv' ? 'text/csv' : 'application/pdf';
  const path = `reports/${requesterId}/${Date.now()}-${reportType}.${extension}`;

  const { error: uploadError } = await supabaseAdmin.storage.from('report-exports').upload(path, buffer, { contentType, upsert: false });
  if (uploadError) throw new Error(`Failed to upload report export: ${uploadError.message}`);

  const { data: signed, error: signError } = await supabaseAdmin.storage.from('report-exports').createSignedUrl(path, 86_400);
  if (signError || !signed) throw new Error(`Failed to create signed URL for report export: ${signError?.message}`);

  const expiresAt = new Date(Date.now() + 86_400 * 1000).toISOString();
  const payload = { job_id: jobId, report_type: reportType, format, download_url: signed.signedUrl, expires_at: expiresAt, requester_id: requesterId };

  notifyUser(requesterId, SOCKET_EVENTS.REPORT_EXPORT_READY, payload);

  await recordAuditLog({
    action: 'REPORT_EXPORTED',
    entityType: 'report',
    entityId: reportType,
    actorId: requesterId,
    actorRole: 'system',
    branchId,
    afterState: { reportType, format, path, async: true },
  });
}

async function processRefreshSnapshot(data: RefreshSnapshotJobData): Promise<void> {
  const { reportType, branchId, filters } = data;
  const rows = await getReportRows(reportType, filters);
  await reportsRepository.saveSnapshot(reportType, branchId, rows, filters);
}

/** After the final retry attempt, report to Sentry and notify the requester — mirrors the old reportWorker.on('failed', ...) handler. */
function handleGenerateExportFailure(jobId: string, data: GenerateExportJobData, error: unknown, attemptsMade: number): void {
  const message = error instanceof Error ? error.message : String(error);
  Sentry.captureException(error);
  const payload = { job_id: jobId, report_type: data.reportType, error: message, requester_id: data.requesterId };
  notifyUser(data.requesterId, SOCKET_EVENTS.REPORT_EXPORT_FAILED, payload);
  void attemptsMade;
}
