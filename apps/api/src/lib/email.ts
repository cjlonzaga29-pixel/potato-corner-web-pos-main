import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;

/**
 * Best-effort email delivery. RESEND_API_KEY is not a required Phase 1 env
 * var (email/SMTP provisioning is out of this phase's local-only scope,
 * same boundary established in Phase 0) — when it's absent, this logs
 * instead of throwing, so the password reset flow still works end-to-end
 * locally without a real email provider.
 */
export async function sendPasswordResetEmail(toEmail: string, resetToken: string): Promise<void> {
  const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/reset-password?token=${resetToken}`;

  if (!resend) {
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
 * slow or failed send never blocks the create-employee request.
 */
export async function sendWelcomeEmail(toEmail: string, firstName: string, employeeId: string, tempPassword: string): Promise<void> {
  const loginUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/login`;

  if (!resend) {
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
