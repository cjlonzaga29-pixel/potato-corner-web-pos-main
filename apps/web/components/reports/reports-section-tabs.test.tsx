import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReportsSectionTabs } from './reports-section-tabs';
import { ADMIN_NAV_ITEMS } from '@/components/admin/admin-sidebar';
import { isNavItemActive } from '@/components/shared/nav-active';

const { mockPathname } = vi.hoisted(() => ({ mockPathname: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: mockPathname }));

afterEach(cleanup);

describe('ReportsSectionTabs', () => {
  it('links Sales & operations and Payroll, marking the current one', () => {
    mockPathname.mockReturnValue('/supervisor/reports/payroll');
    render(<ReportsSectionTabs basePath="/supervisor/reports" />);
    const payroll = screen.getByRole('link', { name: 'Payroll' });
    expect(payroll.getAttribute('href')).toBe('/supervisor/reports/payroll');
    expect(payroll.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Sales & operations' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks Sales & operations on the reports page itself', () => {
    mockPathname.mockReturnValue('/admin/reports');
    render(<ReportsSectionTabs basePath="/admin/reports" />);
    expect(screen.getByRole('link', { name: 'Sales & operations' }).getAttribute('aria-current')).toBe('page');
  });

  it('keeps the admin Reports nav item highlighted on the payroll page', () => {
    const reports = ADMIN_NAV_ITEMS.find((item) => item.label === 'Reports');
    expect(reports && isNavItemActive('/admin/reports/payroll', reports)).toBe(true);
  });
});
