import { describe, it, expect } from 'vitest';
import { extraSupplyIssueHref } from './extra-supply-labels';

describe('extraSupplyIssueHref (POS-PERF-P64)', () => {
  it('sends Admin to the Extra Supplies report under Reports', () => {
    expect(extraSupplyIssueHref('/admin/inventory/movements', 'iss-1')).toBe('/admin/reports?tab=EXTRA_SUPPLIES&issue=iss-1');
  });

  it('keeps Supervisor and Branch on their own history pages', () => {
    expect(extraSupplyIssueHref('/supervisor/inventory', 'iss-1')).toBe('/supervisor/extra-supplies?issue=iss-1');
    expect(extraSupplyIssueHref('/branch/inventory', 'a b')).toBe('/branch/extra-supplies?issue=a%20b');
  });
});
