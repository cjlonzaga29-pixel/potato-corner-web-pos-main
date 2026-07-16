import { Queue, Worker, type Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { SOCKET_EVENTS, type ReportType } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';
import { generateCsv } from '../lib/reports/csv.js';
import { generatePdf } from '../lib/reports/pdf.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { prisma } from '../lib/prisma.js';
import { reportsRepository } from '../modules/reports/reports.repository.js';
import { getReportRows, REPORT_COLUMNS } from '../modules/reports/reports.columns.js';
import type { ReportFilters } from '../modules/reports/reports.types.js';

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

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

export const reportQueue = new Queue('report', { connection: redis });

/**
 * Enqueues an async export job (large CSV or any PDF, Task 12). Processed
 * by `reportWorker` below via `processGenerateExport`.
 */
export function enqueueGenerateExport(data: GenerateExportJobData): Promise<Job> {
  return reportQueue.add('generate_export', data, { attempts: MAX_ATTEMPTS, backoff: { type: 'custom' } });
}

/**
 * Enqueues a background recompute of a pre-computed report snapshot
 * (Task 11's stale-while-revalidate path). Fire-and-forget from the
 * caller's perspective — the request already served the stale snapshot.
 */
export function enqueueRefreshSnapshot(data: RefreshSnapshotJobData): Promise<Job> {
  return reportQueue.add('refresh_snapshot', data, { attempts: 1 });
}

async function processGenerateExport(job: Job<GenerateExportJobData>): Promise<void> {
  const { reportType, filters, format, requesterId, branchId } = job.data;
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
  const payload = { job_id: job.id ?? '', report_type: reportType, format, download_url: signed.signedUrl, expires_at: expiresAt, requester_id: requesterId };

  notifySuperAdmin(SOCKET_EVENTS.REPORT_EXPORT_READY, payload);
  if (branchId) notifyBranch(branchId, SOCKET_EVENTS.REPORT_EXPORT_READY, payload);

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

async function processRefreshSnapshot(job: Job<RefreshSnapshotJobData>): Promise<void> {
  const { reportType, branchId, filters } = job.data;
  const rows = await getReportRows(reportType, filters);
  await reportsRepository.saveSnapshot(reportType, branchId, rows, filters);
}

/**
 * Report queue worker. Handles two job types: `generate_export` (async CSV
 * or PDF export, uploaded to Supabase Storage and delivered via a signed
 * URL over Socket.io) and `refresh_snapshot` (stale-while-revalidate
 * recompute of a pre-computed report, Task 11). Retry backoff follows the
 * architecture spec's 10s/60s/300s schedule (Architecture doc §3.6).
 */
export const reportWorker = new Worker(
  'report',
  async (job: Job) => {
    if (job.name === 'generate_export') {
      await processGenerateExport(job as Job<GenerateExportJobData>);
      return;
    }
    if (job.name === 'refresh_snapshot') {
      await processRefreshSnapshot(job as Job<RefreshSnapshotJobData>);
      return;
    }
  },
  { connection: createWorkerConnection(), settings: { backoffStrategy: retryDelayMs } },
);

reportWorker.on('failed', (job, error) => {
  if (!job || job.name !== 'generate_export') return;
  if (job.attemptsMade < (job.opts.attempts ?? MAX_ATTEMPTS)) return;

  Sentry.captureException(error);
  const { reportType, requesterId, branchId } = job.data as GenerateExportJobData;
  const payload = { job_id: job.id ?? '', report_type: reportType, error: error.message, requester_id: requesterId };
  notifySuperAdmin(SOCKET_EVENTS.REPORT_EXPORT_FAILED, payload);
  if (branchId) notifyBranch(branchId, SOCKET_EVENTS.REPORT_EXPORT_FAILED, payload);
});
