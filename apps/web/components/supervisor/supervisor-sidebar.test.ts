import { describe, expect, it } from 'vitest';
import { SUPERVISOR_NAV_ITEMS } from './supervisor-sidebar';

describe('SUPERVISOR_NAV_ITEMS (POS-PERF-P56)', () => {
  const hrefs = SUPERVISOR_NAV_ITEMS.map((item) => item.href);

  it('has a Payroll entry at the existing Reports route', () => {
    expect(SUPERVISOR_NAV_ITEMS.find((item) => item.label === 'Payroll')?.href).toBe('/supervisor/reports/payroll');
  });

  it('no longer offers Cash Management', () => {
    expect(hrefs).not.toContain('/supervisor/cash');
    expect(SUPERVISOR_NAV_ITEMS.some((item) => item.label === 'Cash Management')).toBe(false);
  });
});
