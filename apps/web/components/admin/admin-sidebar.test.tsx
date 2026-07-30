import { describe, it, expect } from 'vitest';
import { ADMIN_NAV_ITEMS } from './admin-sidebar';

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
