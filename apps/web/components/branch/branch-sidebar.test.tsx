import { describe, it, expect } from 'vitest';
import { branchNavItemsForRole, branchNavGroupsForRole } from './branch-sidebar';

describe('branchNavItemsForRole', () => {
  it('excludes branch-only items like Employees from the staff subset', () => {
    expect(branchNavItemsForRole('staff').map((i) => i.href)).not.toContain('/branch/employees');
  });

  it('does not show a separate Clock In / Out item — it lives inside POS Terminal', () => {
    expect(branchNavItemsForRole('branch').map((i) => i.href)).not.toContain('/branch/clock-in');
    expect(branchNavItemsForRole('staff').map((i) => i.href)).not.toContain('/branch/clock-in');
  });

  it('does not show Cash Management or Cash Reconciliation as top-level items', () => {
    const hrefs = branchNavItemsForRole('branch').map((i) => i.href);
    expect(hrefs).not.toContain('/branch/cash');
    expect(hrefs).not.toContain('/branch/cash/reconciliation');
  });

  it('does not show Expenses, Analytics, or Activity Logs as top-level items — they live inside Reports', () => {
    const hrefs = branchNavItemsForRole('branch').map((i) => i.href);
    expect(hrefs).not.toContain('/branch/expenses');
    expect(hrefs).not.toContain('/branch/analytics');
    expect(hrefs).not.toContain('/branch/activity-logs');
  });

  // POS-PERF-P26 — Products, Employees, Attendance, Reports, and Branch
  // Settings were removed entirely for the Branch Account.
  it('does not show Products, Employees, Attendance, Reports, or Branch Settings for the branch role', () => {
    const hrefs = branchNavItemsForRole('branch').map((i) => i.href);
    expect(hrefs).not.toContain('/branch/products');
    expect(hrefs).not.toContain('/branch/employees');
    expect(hrefs).not.toContain('/branch/attendance');
    expect(hrefs).not.toContain('/branch/reports');
    expect(hrefs).not.toContain('/branch/settings');
  });

  it('does not show Notifications, Receipts, or Profile for the branch role — staff keeps them', () => {
    const branchHrefs = branchNavItemsForRole('branch').map((i) => i.href);
    expect(branchHrefs).not.toContain('/branch/notifications');
    expect(branchHrefs).not.toContain('/branch/receipts');
    expect(branchHrefs).not.toContain('/branch/profile');

    const staffHrefs = branchNavItemsForRole('staff').map((i) => i.href);
    expect(staffHrefs).toContain('/branch/notifications');
    expect(staffHrefs).toContain('/branch/receipts');
    expect(staffHrefs).toContain('/branch/profile');
  });

  it('does not produce any broken (undefined) hrefs', () => {
    for (const item of branchNavItemsForRole('branch')) {
      expect(item.href).toBeTruthy();
    }
  });
});

describe('branchNavGroupsForRole', () => {
  it('groups items under the expected section headers, in order, dropping the now-empty Products/People/Reports sections', () => {
    const groups = branchNavGroupsForRole('branch').map((g) => g.group);
    expect(groups).toEqual(['Overview', 'Inventory']);
  });

  it('places POS Terminal under Overview', () => {
    const overview = branchNavGroupsForRole('staff').find((g) => g.group === 'Overview');
    expect(overview?.items.map((i) => i.href)).toContain('/branch/terminal');
  });
});
