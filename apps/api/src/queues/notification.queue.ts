import { SOCKET_EVENTS } from '@potato-corner/shared';
import { runFireAndForget, runWithRetry } from '../lib/job-runner.js';
import { sendWelcomeEmail, sendFraudAlertEmail, sendLargeAdjustmentApprovalEmail, sendEodSummaryEmail } from '../lib/email.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';
import { notificationsRepository } from '../modules/notifications/notifications.repository.js';
import type { NotificationPayload, NotificationType } from '../modules/notifications/notifications.types.js';

/**
 * Phase 21: BullMQ (Queue + Worker backed by Redis) removed — jobs now run
 * directly in the API process (see the design note in lib/job-runner.ts).
 * `enqueueNotification` no longer persists a job; a job that's mid-retry
 * when the process restarts is lost, where BullMQ would have resumed it
 * from Redis. Architecture doc §3.6 / Phase 18 Decision 7's 10s/60s/300s
 * backoff schedule is preserved via runWithRetry.
 */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

/**
 * Enqueues a job named for the notification type, with the payload as the
 * job's data (matching every existing handler's `job.data as <TypePayload>`
 * pattern — not wrapped) and Decision 7's retry policy. Recipient resolution
 * happens inside processNotification when the job runs, the same way
 * Task 4's inventory_deduction_failed/inventory_product_unavailable handlers
 * already resolve recipients — callers of this function never select
 * recipients themselves. Returns immediately; processing (and retries)
 * happen in the background, matching the old queue.add()'s "enqueued, not
 * yet processed" semantics.
 */
export function enqueueNotification(type: NotificationType, payload: NotificationPayload): Promise<void> {
  return enqueueRawNotificationJob(type, payload);
}

/**
 * Untyped counterpart of enqueueNotification, for the job names that were
 * always enqueued via a bare `notificationQueue.add(name, data)` rather
 * than the NotificationType-constrained wrapper above: employee_welcome
 * (employees.service.ts) and low_stock_alert/inventory_product_unavailable/
 * inventory_deduction_failed (queues/inventory.queue.ts, inventory.service.ts)
 * — none of these are NotificationType values or full NotificationPayload
 * shapes (inventory_deduction_failed's job data, for one, has no `type`
 * field). Same retry policy and fire-and-forget semantics as
 * enqueueNotification.
 */
export function enqueueRawNotificationJob(jobName: string, data: unknown): Promise<void> {
  runFireAndForget(
    () => runWithRetry(() => processNotification(jobName, data), RETRY_DELAYS_MS),
    (error) => console.error(`Notification job "${jobName}" failed after ${RETRY_DELAYS_MS.length} attempt(s):`, error),
  );
  return Promise.resolve();
}

/**
 * Task 10's error-handling contract: an email delivery failure must not
 * fail the whole job — the Notification row is already persisted and the
 * socket event already emitted by the time this runs, so retrying the job
 * would only re-create duplicate Notification rows, not fix the email.
 * Logged so ops can see it (e.g. Resend outage) without losing the alert.
 */
async function sendEmailBestEffort(send: () => Promise<void>, context: string): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error(`Failed to send ${context}:`, error);
  }
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
 * Notification processor. Phase 5 wires up employee_welcome; Phase 8 adds
 * the inventory queue's decoupled alert delivery (low_stock_alert,
 * inventory_deduction_failed) per the architecture spec's retry policy
 * (10s, 60s, 300s backoff for inventory; see Architecture doc §3.6 for the
 * per-queue behavior).
 */
export async function processNotification(jobName: string, data: unknown): Promise<void> {
  if (jobName === 'employee_welcome') {
    const { toEmail, firstName, employeeId, tempPassword } = data as EmployeeWelcomeJobData;
    await sendWelcomeEmail(toEmail, firstName, employeeId, tempPassword);
    return;
  }
  if (jobName === 'low_stock_alert') {
    const payload = data as LowStockAlertJobData;
    const event = payload.currentStock <= 0 ? SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK : SOCKET_EVENTS.INVENTORY_LOW_STOCK;
    notifyBranch(payload.branchId, event, payload);
    notifySuperAdmin(event, payload);
    // inventory.queue.ts only ever enqueues this one job name for all three
    // stock-level types — the notification `type` is derived here, not from
    // the enqueue call, matching the same severity/currentStock logic used
    // above to pick the socket event.
    const stockType = payload.currentStock <= 0 ? 'out_of_stock' : payload.severity === 'critical' ? 'critical_stock' : 'low_stock';
    const stockPayload = {
      type: stockType,
      branchId: payload.branchId,
      ingredientId: payload.ingredientId,
      ingredientName: payload.ingredientName,
      currentStock: payload.currentStock,
      lowStockThreshold: payload.lowStockThreshold,
      criticalThreshold: payload.criticalThreshold,
    } as NotificationPayload;
    const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(payload.branchId);
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({
          type: stockType,
          payload: stockPayload,
          recipientUserId: recipient.id,
          branchId: payload.branchId,
        }),
      ),
    );
    return;
  }
  if (jobName === 'inventory_deduction_failed') {
    const payload = data as InventoryDeductionFailedJobData;
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
          payload: { type: 'inventory_deduction_failed', transactionId: payload.transactionId, branchId: payload.branchId, error: payload.error },
          recipientUserId: recipient.id,
          branchId: payload.branchId,
        }),
      ),
    );
    console.error(`Inventory deduction failed for transaction ${payload.transactionId} (branch ${payload.branchId}):`, payload.error);
    return;
  }
  if (jobName === 'inventory_product_unavailable') {
    const payload = data as InventoryProductUnavailableJobData;
    // The branch/super-admin socket broadcast already happened directly
    // from the inventory worker (queues/inventory.queue.ts) at cascade
    // time (SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE) — re-emitting it
    // here would double-broadcast to connected clients. This job persists
    // the durable in-app Notification row the socket-only broadcast never
    // gave callers a way to read later.
    const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(payload.branchId);
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({
          type: 'product_auto_unavailable',
          payload: {
            type: 'product_auto_unavailable',
            branchId: payload.branchId,
            triggeredByIngredientId: payload.triggeredByIngredientId,
            triggeredByIngredientName: payload.triggeredByIngredientName,
            affectedFlavors: payload.affectedFlavors,
            affectedProducts: payload.affectedProducts,
          },
          recipientUserId: recipient.id,
          branchId: payload.branchId,
        }),
      ),
    );
    console.warn(
      `Out-of-stock cascade at branch ${payload.branchId}: ${payload.affectedFlavors.length} flavor(s), ${payload.affectedProducts.length} product(s) marked unavailable (triggered by ${payload.triggeredByIngredientName})`,
    );
    return;
  }
  if (jobName === 'cash_variance_flagged') {
    const payload = data as Extract<NotificationPayload, { type: 'cash_variance_flagged' }>;
    notifyBranch(payload.branchId, SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, payload);
    notifySuperAdmin(SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, payload);
    const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(payload.branchId);
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({ type: 'cash_variance_flagged', payload, recipientUserId: recipient.id, branchId: payload.branchId }),
      ),
    );
    return;
  }
  if (jobName === 'void_requested') {
    const payload = data as Extract<NotificationPayload, { type: 'void_requested' }>;
    notifyBranch(payload.branchId, SOCKET_EVENTS.VOID_REQUESTED, payload);
    notifySuperAdmin(SOCKET_EVENTS.VOID_REQUESTED, payload);
    // Branch supervisors only (Task 6 recipient matrix) — no super admins,
    // unlike cash_variance_flagged/low_stock above.
    const recipients = await notificationsRepository.findBranchSupervisorUserIds(payload.branchId);
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({ type: 'void_requested', payload, recipientUserId: recipient.id, branchId: payload.branchId }),
      ),
    );
    return;
  }
  if (jobName === 'large_adjustment_approval_needed') {
    const payload = data as Extract<NotificationPayload, { type: 'large_adjustment_approval_needed' }>;
    notifyBranch(payload.branchId, SOCKET_EVENTS.LARGE_ADJUSTMENT_APPROVAL_NEEDED, payload);
    notifySuperAdmin(SOCKET_EVENTS.LARGE_ADJUSTMENT_APPROVAL_NEEDED, payload);
    // Super admins (company-wide) plus the branch's own supervisors — real
    // financial stakes at the pilot branch mean the branch's own
    // supervisor needs visibility too, not just Super Admin (Phase 20 Task 5).
    const recipients = await notificationsRepository.findBranchSupervisorAndAdminUserIds(payload.branchId);
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({
          type: 'large_adjustment_approval_needed',
          payload,
          recipientUserId: recipient.id,
          branchId: payload.branchId,
        }),
      ),
    );
    await Promise.all(
      recipients.map((recipient) =>
        sendEmailBestEffort(() => sendLargeAdjustmentApprovalEmail(recipient.email, payload), `large adjustment approval email to ${recipient.email}`),
      ),
    );
    return;
  }
  if (jobName === 'fraud_alert_created') {
    const payload = data as Extract<NotificationPayload, { type: 'fraud_alert_created' }>;
    // detection.service.ts's own notifySuperAdmin call already broadcasts
    // this at alert-creation time — not duplicated here, same reasoning as
    // inventory_product_unavailable above.
    const recipients = await notificationsRepository.findSuperAdminUserIds();
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({ type: 'fraud_alert_created', payload, recipientUserId: recipient.id, branchId: payload.branchId }),
      ),
    );
    await Promise.all(
      recipients.map((recipient) =>
        sendEmailBestEffort(() => sendFraudAlertEmail(recipient.email, payload), `fraud alert email to ${recipient.email}`),
      ),
    );
    return;
  }
  if (jobName === 'offline_transactions_synced') {
    const payload = data as Extract<NotificationPayload, { type: 'offline_transactions_synced' }>;
    notifyBranch(payload.branchId, SOCKET_EVENTS.OFFLINE_TRANSACTIONS_SYNCED, payload);
    // Informational, branch supervisors only.
    const recipients = await notificationsRepository.findBranchSupervisorUserIds(payload.branchId);
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({
          type: 'offline_transactions_synced',
          payload,
          recipientUserId: recipient.id,
          branchId: payload.branchId,
        }),
      ),
    );
    return;
  }
  if (jobName === 'eod_summary') {
    const payload = data as Extract<NotificationPayload, { type: 'eod_summary' }>;
    notifySuperAdmin(SOCKET_EVENTS.EOD_SUMMARY, payload);
    const recipients = await notificationsRepository.findSuperAdminUserIds();
    await Promise.all(
      recipients.map((recipient) =>
        notificationsRepository.create({ type: 'eod_summary', payload, recipientUserId: recipient.id, branchId: payload.branchId }),
      ),
    );
    await Promise.all(
      recipients.map((recipient) => sendEmailBestEffort(() => sendEodSummaryEmail(recipient.email, payload), `EOD summary email to ${recipient.email}`)),
    );
    return;
  }
}
