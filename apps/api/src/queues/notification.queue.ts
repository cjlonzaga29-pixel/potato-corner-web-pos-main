import { Queue, Worker, type Job } from 'bullmq';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { redis } from '../lib/redis.js';
import { sendWelcomeEmail } from '../lib/email.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';

export const notificationQueue = new Queue('notification', { connection: redis });

interface EmployeeWelcomeJobData {
  toEmail: string;
  firstName: string;
  employeeId: string;
  tempPassword: string;
}

interface LowStockAlertJobData {
  branchId: string;
  ingredientId: string;
  ingredientName: string;
  currentStock: number;
  lowStockThreshold: number;
  criticalThreshold: number;
  severity: 'low' | 'critical';
}

interface InventoryDeductionFailedJobData {
  transactionId: string;
  branchId: string;
  error: string;
}

/**
 * Notification queue worker. Phase 5 wires up employee_welcome; Phase 8
 * adds the inventory queue's decoupled alert delivery (low_stock_alert,
 * inventory_deduction_failed) per the architecture spec's retry policy
 * (10s, 60s, 300s backoff for inventory; see Architecture doc §3.6 for the
 * per-queue behavior).
 */
export const notificationWorker = new Worker(
  'notification',
  async (job: Job) => {
    if (job.name === 'employee_welcome') {
      const { toEmail, firstName, employeeId, tempPassword } = job.data as EmployeeWelcomeJobData;
      await sendWelcomeEmail(toEmail, firstName, employeeId, tempPassword);
      return;
    }
    if (job.name === 'low_stock_alert') {
      const data = job.data as LowStockAlertJobData;
      const event = data.currentStock <= 0 ? SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK : SOCKET_EVENTS.INVENTORY_LOW_STOCK;
      notifyBranch(data.branchId, event, data);
      notifySuperAdmin(event, data);
      return;
    }
    if (job.name === 'inventory_deduction_failed') {
      const data = job.data as InventoryDeductionFailedJobData;
      // No socket event constant exists for this case, and inventing one
      // here would define a frontend contract Step 3 doesn't cover. The
      // audit log entry and the transaction's `failed` status (both written
      // by the inventory worker before this job is enqueued) are already
      // the durable, queryable record — this job just keeps that failure
      // visible in server logs until a UI is built to consume a real event.
      console.error(`Inventory deduction failed for transaction ${data.transactionId} (branch ${data.branchId}):`, data.error);
      return;
    }
    // TODO(Phase 8+): implement remaining notification types.
  },
  { connection: redis },
);
