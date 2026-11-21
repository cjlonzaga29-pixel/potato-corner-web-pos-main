import { describe, it, expect, vi } from 'vitest';

const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

const { default: AdminAttendanceRedirectPage } = await import('./page');

// POS-PERF-P64 — the records view moved to Admin › Reports; its body is tested in components/admin/admin-attendance-report.test.tsx.
describe('/admin/attendance', () => {
  it('redirects to the Reports Attendance Records tab', () => {
    AdminAttendanceRedirectPage();
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith('/admin/reports?tab=ATTENDANCE_RECORDS');
  });
});
