import { redirect } from 'next/navigation';
import { buildAdminAttendanceRedirect } from '@/lib/admin-report-redirect';

/**
 * POS-PERF-P64 — Admin views attendance only under Reports (Operations ›
 * Attendance Records); the body lives in components/admin/admin-attendance-report.tsx.
 * That view keeps its filters in local state, so no query params are forwarded.
 * Role protection is unchanged: this route is still inside the (admin) group
 * the middleware guards. Supervisor attendance is untouched.
 */
export default function AdminAttendanceRedirectPage(): never {
  redirect(buildAdminAttendanceRedirect());
}
