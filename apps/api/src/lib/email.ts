import { Resend } from 'resend';
import { config } from '../config/index.js';
import type {
  EodSummaryNotificationPayload,
  FraudAlertCreatedNotificationPayload,
  LargeAdjustmentApprovalNeededNotificationPayload,
} from '../modules/notifications/notifications.types.js';

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;

/**
 * Best-effort email delivery. RESEND_API_KEY is not a required Phase 1 env
 * var (email/SMTP provisioning is out of this phase's local-only scope,
 * same boundary established in Phase 0) — when it's absent, this logs
 * instead of throwing, so the password reset flow still works end-to-end
 * locally without a real email provider. That console fallback carries a
 * live reset link, so it is development-only: any other environment
 * without a real provider configured must fail loudly instead of leaking
 * the link to whatever is reading stdout.
 */
export async function sendPasswordResetEmail(toEmail: string, resetToken: string): Promise<void> {
  const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/reset-password?token=${resetToken}`;

  if (!resend) {
    if (config.nodeEnv !== 'development') {
      throw new Error('RESEND_API_KEY is not configured — refusing to send a password reset email outside development.');
    }
    console.log(`[email:dev] Password reset link for ${toEmail}: ${resetUrl}`);
    return;
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'no-reply@potatocorner.local',
    to: toEmail,
    subject: 'Reset your Potato Corner POS password',
    html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  });
}

/**
 * Sent once, at employee creation, carrying the admin-set temporary
 * password (locked rule: employee must change it on first login). Same
 * best-effort/dev-log fallback as sendPasswordResetEmail — called from the
 * notification queue's worker, not directly from employees.service.ts, so a
 * slow or failed send never blocks the create-employee request. The console
 * fallback carries a plaintext credential, so it is development-only for
 * the same reason as above; a thrown error here fails the BullMQ job
 * instead, which is the correct outcome (retry/alert, not a silent leak).
 */
export async function sendWelcomeEmail(toEmail: string, firstName: string, employeeId: string, tempPassword: string): Promise<void> {
  const loginUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/login`;

  if (!resend) {
    if (config.nodeEnv !== 'development') {
      throw new Error('RESEND_API_KEY is not configured — refusing to send a welcome email outside development.');
    }
    console.log(`[email:dev] Welcome email for ${toEmail} (${employeeId}) — temporary password: ${tempPassword}`);
    return;
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'no-reply@potatocorner.local',
    to: toEmail,
    subject: 'Welcome to Potato Corner POS',
    html: `<p>Hi ${firstName},</p><p>Your employee account (${employeeId}) has been created. Your temporary password is:</p><p><strong>${tempPassword}</strong></p><p>You will be required to change it on first login.</p><p><a href="${loginUrl}">Sign in</a></p>`,
  });
}

/**
 * Sent to every active Super Admin when the fraud engine opens a new alert
 * (Phase 18 Decision 2). Same best-effort/dev-log fallback contract as the
 * two senders above, except the dev-log branch below is a status line, not
 * a leaked credential — logging it in development is harmless either way.
 */
export async function sendFraudAlertEmail(toEmail: string, payload: FraudAlertCreatedNotificationPayload): Promise<void> {
  const reviewUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/fraud/${payload.alertId}`;

  if (!resend) {
    if (config.nodeEnv !== 'development') {
      throw new Error('RESEND_API_KEY is not configured — refusing to send a fraud alert email outside development.');
    }
    console.log(`[email:dev] Fraud alert (${payload.severity}) for ${toEmail}: ${reviewUrl}`);
    return;
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'no-reply@potatocorner.local',
    to: toEmail,
    subject: `Fraud alert (${payload.severity}) — review required`,
    html: `<p>A new ${payload.severity} severity fraud alert was created for branch ${payload.branchId}.</p><p><a href="${reviewUrl}">Review the alert</a></p>`,
  });
}

/**
 * Sent to every active Super Admin when a supervisor requests an
 * adjustment above the auto-approval threshold (Phase 18 Decision 2).
 */
export async function sendLargeAdjustmentApprovalEmail(
  toEmail: string,
  payload: LargeAdjustmentApprovalNeededNotificationPayload,
): Promise<void> {
  const approvalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/adjustments/${payload.adjustmentId}`;

  if (!resend) {
    if (config.nodeEnv !== 'development') {
      throw new Error('RESEND_API_KEY is not configured — refusing to send a large adjustment approval email outside development.');
    }
    console.log(`[email:dev] Large adjustment approval needed (₱${payload.amount}) for ${toEmail}: ${approvalUrl}`);
    return;
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'no-reply@potatocorner.local',
    to: toEmail,
    subject: `Adjustment approval needed — ₱${payload.amount.toLocaleString('en-PH')}`,
    html: `<p>Branch ${payload.branchId} requested an adjustment of ₱${payload.amount.toLocaleString('en-PH')} that needs Super Admin approval.</p><p><a href="${approvalUrl}">Review the adjustment</a></p>`,
  });
}

/**
 * Sent to every active Super Admin once nightly, 23:59 Asia/Manila (Phase 18
 * Decision 5), carrying the same figures the in-app eod_summary notification
 * persists.
 */
export async function sendEodSummaryEmail(toEmail: string, payload: EodSummaryNotificationPayload): Promise<void> {
  const reportsUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/reports?date=${payload.businessDate}`;

  if (!resend) {
    if (config.nodeEnv !== 'development') {
      throw new Error('RESEND_API_KEY is not configured — refusing to send an EOD summary email outside development.');
    }
    console.log(`[email:dev] EOD summary for ${payload.businessDate} to ${toEmail}: total revenue ₱${payload.totalRevenue}`);
    return;
  }

  const branchRows = payload.branchRevenue
    .map((branch) => `<li>${branch.branchName}: ₱${branch.revenue.toLocaleString('en-PH')}</li>`)
    .join('');

  await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'no-reply@potatocorner.local',
    to: toEmail,
    subject: `EOD summary — ${payload.businessDate}`,
    html: `<p>End-of-day summary for ${payload.businessDate}:</p><ul><li>Total revenue: ₱${payload.totalRevenue.toLocaleString('en-PH')}</li><li>Transactions: ${payload.transactionCount}</li><li>Voids: ${payload.voidCount}</li><li>Unresolved cash variances: ${payload.unresolvedCashVarianceCount}</li><li>Open fraud alerts created today: ${payload.openFraudAlertsCreatedTodayCount}</li></ul><ul>${branchRows}</ul><p><a href="${reportsUrl}">View full report</a></p>`,
  });
}
