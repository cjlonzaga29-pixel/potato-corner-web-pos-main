import { Queue, Worker, type Job } from 'bullmq';
import type { ReportType } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import type { ReportFilters } from '../modules/reports/reports.types.js';

export const reportQueue = new Queue('report', { connection: redis });

export interface RefreshSnapshotJobData {
  reportType: ReportType;
  branchId: string | null;
  filters: ReportFilters;
}

export interface GenerateExportJobData {
  reportType: ReportType;
  filters: ReportFilters;
  format: 'csv' | 'pdf';
  requesterId: string;
  branchId: string | null;
}

/**
 * Enqueues a background recompute of a pre-computed report snapshot
 * (Task 11's stale-while-revalidate path). Fire-and-forget from the
 * caller's perspective — the request already served the stale snapshot.
 * Processor implemented in Task 14.
 */
export function enqueueRefreshSnapshot(data: RefreshSnapshotJobData): Promise<Job> {
  return reportQueue.add('refresh_snapshot', data);
}

/**
 * Enqueues an async export job (large CSV or any PDF, Task 12). Processor
 * implemented in Task 14.
 */
export function enqueueGenerateExport(data: GenerateExportJobData): Promise<Job> {
  return reportQueue.add('generate_export', data);
}

/**
 * Report queue worker. TODO(Phase 14): implement the processor per the
 * architecture spec's retry policy (10s, 60s, 300s backoff for inventory;
 * see Architecture doc §3.6 for the per-queue behavior).
 */
export const reportWorker = new Worker(
  'report',
  async (job: Job) => {
    void job;
    // TODO(Phase 14): implement.
  },
  { connection: createWorkerConnection() },
);
