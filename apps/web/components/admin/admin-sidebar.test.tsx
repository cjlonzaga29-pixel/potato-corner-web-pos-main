import { describe, it, expect } from 'vitest';
import { ADMIN_NAV_ITEMS } from './admin-sidebar';
import { isNavItemActive } from '@/components/shared/nav-active';

// POS-PERF-P40R — which nav item lights up on each admin people/branch route.
describe('admin nav highlighting', () => {
  function activeLabels(pathname: string): string[] {
    return ADMIN_NAV_ITEMS.filter((item) => isNavItemActive(pathname, item)).map((item) => item.label);
  }

  it.each([
    ['/admin/supervisors', ['Supervisors']],
    ['/admin/employees/3f0c2a9e-1111-4222-8333-444455556666', ['Supervisors']],
    ['/admin/employees', ['Supervisors']],
    ['/admin/branch-accounts', ['Branches']],
    ['/admin/branches', ['Branches']],
    ['/admin/attendance', ['Attendance']],
    ['/admin/employeesx', []],
  ])('%s highlights %j', (pathname, expected) => {
    expect(activeLabels(pathname)).toEqual(expected);
  });
});

describe('ADMIN_NAV_ITEMS', () => {
  it('has exactly one Reports entry, linking straight to /admin/reports', () => {
    const reportsItems = ADMIN_NAV_ITEMS.filter((item) => item.label === 'Reports');
    expect(reportsItems).toHaveLength(1);
    expect(reportsItems[0]).not.toHaveProperty('children');
    expect((reportsItems[0] as { href: string }).href).toBe('/admin/reports');
  });

  it('does not expose the legacy report sections as separate sidebar items', () => {
    const labels = ADMIN_NAV_ITEMS.map((item) => item.label);
    for (const legacy of [
      'Financial',
      'Shifts',
      'Fraud Alerts',
      'Discount Compliance',
      'Inventory Movement',
      'Attendance Summary',
      'Audit Log',
    ]) {
      expect(labels).not.toContain(legacy);
    }
  });
});
