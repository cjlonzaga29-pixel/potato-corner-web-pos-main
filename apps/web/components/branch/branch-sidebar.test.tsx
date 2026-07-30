import { describe, it, expect } from 'vitest';
import { branchNavItemsForRole } from './branch-sidebar';

describe('branchNavItemsForRole', () => {
  it('includes Clock In / Out for both branch and staff roles', () => {
    expect(branchNavItemsForRole('branch').map((i) => i.href)).toContain('/branch/clock-in');
    expect(branchNavItemsForRole('staff').map((i) => i.href)).toContain('/branch/clock-in');
  });

  it('excludes branch-only items like Employees from the staff subset', () => {
    expect(branchNavItemsForRole('staff').map((i) => i.href)).not.toContain('/branch/employees');
  });
});
