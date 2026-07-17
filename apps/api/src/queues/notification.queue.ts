import { Queue, Worker, type Job } from 'bullmq';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { sendWelcomeEmail } from '../lib/email.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';
import { notificationsRepository } from '../modules/notifications/notifications.repository.js';
import type { NotificationPayload, NotificationType } from '../modules/notifications/notifications.types.js';

export const notificationQueue = new Queue('notification', { connection: redis });

/**
 * Architecture doc §3.6 / Phase 18 Decision 7: 10s / 60s / 300s backoff,
 * matching inventory.queue.ts's RETRY_DELAYS_MS/retryDelayMs exactly. The
 * attempts/backoff job options themselves are supplied per-call by Task 5's
 * enqueueNotification wrapper — this Worker only needs the resolver function
 * BullMQ calls when a job configured with `backoff: { type: 'custom' }` retries.
 */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

/**
 * Enqueues a job named for the notification type, with the payload as the
 * job's data (matching every existing handler's `job.data as <TypePayload>`
 * pattern — not wrapped) and Decision 7's retry policy. Recipient resolution
 * happens inside the Task 6 handler when the job is processed, the same way
 * Task 4's inventory_deduction_failed/inventory_product_unavailable handlers
 * already resolve recipients — callers of this function never select
 * recipients themselves.
 */
export function enqueueNotification(type: NotificationType, payload: NotificationPayload) {
  return notificationQueue.add(type, payload, { attempts: 3, backoff: { type: 'custom' } });
}

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

interface InventoryProductUnavailableJobData {
  branchId: string;
  triggeredByIngredientId: string;
  triggeredByIngredientName: string;
  affectedFlavors: { flavorId: string; name: string }[];
  affectedProducts: { productId: string; name: string }[];
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
      // inventory.queue.ts only ever enqueues this one job name for all three
      // stock-level types — the notification `type` is derived here, not from
      // job.name, matching the same severity/currentStock logic used above
      // to pick the socket event.
      const stockType = data.currentStock <= 0 ? 'out_of_stock' : data.severity === 'critical' ? 'critical_stock' : 'low_stock';
      const stockPayload = {
        type: stockType,
        branchId: data.branchId,
        ingredientId: data.ingredientId,
        ingredientName: data.ingredientName,
        currentStock: data.currentStock,
        lowStockThreshold: data.lowStockThreshold,
        criticalThreshold: data.criticalThreshold,
      } as NotificationPayload;
      const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(data.branchId);
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({
            type: stockType,
            payload: stockPayload,
            recipientUserId: recipient.id,
            branchId: data.branchId,
          }),
        ),
      );
      return;
    }
    if (job.name === 'inventory_deduction_failed') {
      const data = job.data as InventoryDeductionFailedJobData;
      // No socket event constant exists for this case, and inventing one
      // here would define a frontend contract Step 3 doesn't cover. The
      // audit log entry and the transaction's `failed` status (both written
      // by the inventory worker before this job is enqueued) are already
      // the durable, queryable record — this job persists an in-app
      // notification (Phase 18) on top of that, visible via the read API.
      const recipients = await notificationsRepository.findSuperAdminUserIds();
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({
            type: 'inventory_deduction_failed',
            payload: { type: 'inventory_deduction_failed', transactionId: data.transactionId, branchId: data.branchId, error: data.error },
            recipientUserId: recipient.id,
            branchId: data.branchId,
          }),
        ),
      );
      console.error(`Inventory deduction failed for transaction ${data.transactionId} (branch ${data.branchId}):`, data.error);
      return;
    }
    if (job.name === 'inventory_product_unavailable') {
      const data = job.data as InventoryProductUnavailableJobData;
      // The branch/super-admin socket broadcast already happened directly
      // from the inventory worker (queues/inventory.queue.ts) at cascade
      // time (SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE) — re-emitting it
      // here would double-broadcast to connected clients. This job persists
      // the durable in-app Notification row the socket-only broadcast never
      // gave callers a way to read later.
      const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(data.branchId);
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({
            type: 'product_auto_unavailable',
            payload: {
              type: 'product_auto_unavailable',
              branchId: data.branchId,
              triggeredByIngredientId: data.triggeredByIngredientId,
              triggeredByIngredientName: data.triggeredByIngredientName,
              affectedFlavors: data.affectedFlavors,
              affectedProducts: data.affectedProducts,
            },
            recipientUserId: recipient.id,
            branchId: data.branchId,
          }),
        ),
      );
      console.warn(
        `Out-of-stock cascade at branch ${data.branchId}: ${data.affectedFlavors.length} flavor(s), ${data.affectedProducts.length} product(s) marked unavailable (triggered by ${data.triggeredByIngredientName})`,
      );
      return;
    }
    if (job.name === 'cash_variance_flagged') {
      const data = job.data as Extract<NotificationPayload, { type: 'cash_variance_flagged' }>;
      notifyBranch(data.branchId, SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, data);
      notifySuperAdmin(SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, data);
      const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(data.branchId);
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({ type: 'cash_variance_flagged', payload: data, recipientUserId: recipient.id, branchId: data.branchId }),
        ),
      );
      return;
    }
    if (job.name === 'void_requested') {
      const data = job.data as Extract<NotificationPayload, { type: 'void_requested' }>;
      notifyBranch(data.branchId, SOCKET_EVENTS.VOID_REQUESTED, data);
      notifySuperAdmin(SOCKET_EVENTS.VOID_REQUESTED, data);
      // Branch supervisors only (Task 6 recipient matrix) — no super admins,
      // unlike cash_variance_flagged/low_stock above.
      const recipients = await notificationsRepository.findBranchSupervisorUserIds(data.branchId);
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({ type: 'void_requested', payload: data, recipientUserId: recipient.id, branchId: data.branchId }),
        ),
      );
      return;
    }
    if (job.name === 'large_adjustment_approval_needed') {
      const data = job.data as Extract<NotificationPayload, { type: 'large_adjustment_approval_needed' }>;
      notifySuperAdmin(SOCKET_EVENTS.LARGE_ADJUSTMENT_APPROVAL_NEEDED, data);
      const recipients = await notificationsRepository.findSuperAdminUserIds();
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({
            type: 'large_adjustment_approval_needed',
            payload: data,
            recipientUserId: recipient.id,
            branchId: data.branchId,
          }),
        ),
      );
      // TODO(Task 10): send email via Resend
      return;
    }
    if (job.name === 'fraud_alert_created') {
      const data = job.data as Extract<NotificationPayload, { type: 'fraud_alert_created' }>;
      // detection.service.ts's own notifySuperAdmin call already broadcasts
      // this at alert-creation time — not duplicated here, same reasoning as
      // inventory_product_unavailable above.
      const recipients = await notificationsRepository.findSuperAdminUserIds();
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({ type: 'fraud_alert_created', payload: data, recipientUserId: recipient.id, branchId: data.branchId }),
        ),
      );
      // TODO(Task 10): send email via Resend
      return;
    }
    if (job.name === 'offline_transactions_synced') {
      const data = job.data as Extract<NotificationPayload, { type: 'offline_transactions_synced' }>;
      notifyBranch(data.branchId, SOCKET_EVENTS.OFFLINE_TRANSACTIONS_SYNCED, data);
      // Informational, branch supervisors only.
      const recipients = await notificationsRepository.findBranchSupervisorUserIds(data.branchId);
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({
            type: 'offline_transactions_synced',
            payload: data,
            recipientUserId: recipient.id,
            branchId: data.branchId,
          }),
        ),
      );
      return;
    }
    if (job.name === 'eod_summary') {
      const data = job.data as Extract<NotificationPayload, { type: 'eod_summary' }>;
      notifySuperAdmin(SOCKET_EVENTS.EOD_SUMMARY, data);
      const recipients = await notificationsRepository.findSuperAdminUserIds();
      await Promise.all(
        recipients.map((recipient) =>
          notificationsRepository.create({ type: 'eod_summary', payload: data, recipientUserId: recipient.id, branchId: data.branchId }),
        ),
      );
      // TODO(Task 10): send email via Resend
      return;
    }
  },
  {
    connection: createWorkerConnection(),
    settings: {
      backoffStrategy: retryDelayMs,
    },
  },
);
