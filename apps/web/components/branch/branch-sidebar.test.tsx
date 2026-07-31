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

  it('shows exactly one Reports item', () => {
    expect(branchNavItemsForRole('branch').filter((i) => i.label === 'Reports')).toHaveLength(1);
  });

  it('does not produce any broken (undefined) hrefs', () => {
    for (const item of branchNavItemsForRole('branch')) {
      expect(item.href).toBeTruthy();
    }
  });
});

describe('branchNavGroupsForRole', () => {
  it('groups items under the expected section headers, in order', () => {
    const groups = branchNavGroupsForRole('branch').map((g) => g.group);
    expect(groups).toEqual(['Overview', 'Inventory', 'Products', 'People', 'Reports', 'Settings']);
  });

  it('places POS Terminal under Overview', () => {
    const overview = branchNavGroupsForRole('staff').find((g) => g.group === 'Overview');
    expect(overview?.items.map((i) => i.href)).toContain('/branch/terminal');
  });
});
