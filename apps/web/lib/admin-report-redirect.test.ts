import { describe, it, expect } from 'vitest';
import { buildAdminAttendanceRedirect, buildAdminExtraSuppliesRedirect, buildAdminReportRedirect } from './admin-report-redirect';

describe('buildAdminExtraSuppliesRedirect', () => {
  it('lands on the Reports Extra Supplies tab with no filters', () => {
    expect(buildAdminExtraSuppliesRedirect()).toBe('/admin/reports?tab=EXTRA_SUPPLIES');
    expect(buildAdminExtraSuppliesRedirect({})).toBe('/admin/reports?tab=EXTRA_SUPPLIES');
  });

  it('carries over every filter the history reads, in a stable order', () => {
    const url = buildAdminExtraSuppliesRedirect({
      issue: 'i-1',
      cashier_id: 'c-1',
      kind: 'paid',
      extra_supply_id: 's-1',
      date_to: '2026-11-04',
      date_from: '2026-11-01',
      branch_id: 'b-1',
    });
    expect(url).toBe('/admin/reports?tab=EXTRA_SUPPLIES&branch_id=b-1&date_from=2026-11-01&date_to=2026-11-04&extra_supply_id=s-1&kind=paid&cashier_id=c-1&issue=i-1');
  });

  it('drops unknown params, including an attempt to override the tab', () => {
    const url = buildAdminExtraSuppliesRedirect({ branch_id: 'b-1', tab: 'DAILY_SALES', next: 'https://evil.example', page: '3' });
    expect(url).toBe('/admin/reports?tab=EXTRA_SUPPLIES&branch_id=b-1');
  });

  it('drops repeated (array), empty, whitespace-only and oversized values', () => {
    const url = buildAdminExtraSuppliesRedirect({
      branch_id: ['b-1', 'b-2'],
      date_from: '',
      date_to: '   ',
      kind: undefined,
      cashier_id: 'x'.repeat(101),
      issue: 'i-1',
    });
    expect(url).toBe('/admin/reports?tab=EXTRA_SUPPLIES&issue=i-1');
  });

  it('URL-encodes values so they cannot inject extra params', () => {
    const url = buildAdminExtraSuppliesRedirect({ branch_id: 'b-1&tab=DAILY_SALES', cashier_id: 'a b/#?' });
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/admin/reports');
    expect(parsed.searchParams.getAll('tab')).toEqual(['EXTRA_SUPPLIES']);
    expect(parsed.searchParams.get('branch_id')).toBe('b-1&tab=DAILY_SALES');
    expect(parsed.searchParams.get('cashier_id')).toBe('a b/#?');
  });

  it('ignores inherited properties rather than reading them as params', () => {
    const params = Object.create({ branch_id: 'inherited' }) as Record<string, string>;
    expect(buildAdminExtraSuppliesRedirect(params)).toBe('/admin/reports?tab=EXTRA_SUPPLIES');
  });
});

describe('buildAdminAttendanceRedirect', () => {
  it('lands on the Reports Attendance Records tab and forwards nothing (the view reads no URL filters)', () => {
    expect(buildAdminAttendanceRedirect()).toBe('/admin/reports?tab=ATTENDANCE_RECORDS');
    expect(buildAdminAttendanceRedirect({ branch_id: 'b-1', from: '2026-11-01', employee_id: 'e-1', tab: 'DAILY_SALES' })).toBe('/admin/reports?tab=ATTENDANCE_RECORDS');
  });

  it('never points back at /admin/attendance, so it cannot loop', () => {
    expect(new URL(buildAdminAttendanceRedirect(), 'http://localhost').pathname).toBe('/admin/reports');
  });
});

describe('buildAdminReportRedirect', () => {
  it('refuses to let an allowlist entry named "tab" replace the destination tab', () => {
    expect(buildAdminReportRedirect('EXTRA_SUPPLIES', ['tab'], { tab: 'DAILY_SALES' })).toBe('/admin/reports?tab=EXTRA_SUPPLIES');
  });
});
