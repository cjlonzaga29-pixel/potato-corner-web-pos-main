import { Queue, Worker, type Job } from 'bullmq';
import { redis } from '../lib/redis.js';

export const fraudQueue = new Queue('fraud', { connection: redis });

/**
 * Fraud queue worker. TODO(Phase 8+): implement the processor per the
 * architecture spec's retry policy (10s, 60s, 300s backoff for inventory;
 * see Architecture doc §3.6 for the per-queue behavior).
 */
export const fraudWorker = new Worker(
  'fraud',
  async (job: Job) => {
    void job;
    // TODO(Phase 8+): implement.
  },
  { connection: redis },
);
