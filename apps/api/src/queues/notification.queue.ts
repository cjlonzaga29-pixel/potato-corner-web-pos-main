import { Queue, Worker, type Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { sendWelcomeEmail } from '../lib/email.js';

export const notificationQueue = new Queue('notification', { connection: redis });

interface EmployeeWelcomeJobData {
  toEmail: string;
  firstName: string;
  employeeId: string;
  tempPassword: string;
}

/**
 * Notification queue worker. Phase 5 wires up the one job type it needs
 * (employee_welcome); every other notification type is still
 * TODO(Phase 8+) per the architecture spec's retry policy (10s, 60s, 300s
 * backoff for inventory; see Architecture doc §3.6 for the per-queue
 * behavior).
 */
export const notificationWorker = new Worker(
  'notification',
  async (job: Job) => {
    if (job.name === 'employee_welcome') {
      const { toEmail, firstName, employeeId, tempPassword } = job.data as EmployeeWelcomeJobData;
      await sendWelcomeEmail(toEmail, firstName, employeeId, tempPassword);
      return;
    }
    // TODO(Phase 8+): implement remaining notification types.
  },
  { connection: redis },
);
