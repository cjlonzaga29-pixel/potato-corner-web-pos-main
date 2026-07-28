import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BranchSessionGuard } from './branch-session-guard';

const mockReplace = vi.fn();
let mockPathname = '/branch/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
}));

let mockUser: { role: string } | undefined = { role: 'branch' };
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

afterEach(() => {
  cleanup();
  mockReplace.mockClear();
});

/** CR-010 R5 — only POS Terminal requires an active employee selection; every other branch page must open immediately. */
describe('BranchSessionGuard', () => {
  it.each(['/branch/dashboard', '/branch/inventory', '/branch/inventory/stock-in', '/branch/products', '/branch/sales', '/branch/reports'])(
    'does not redirect a branch session with no employee selected on %s',
    (pathname) => {
      mockPathname = pathname;
      mockUser = { role: 'branch' };
      render(<BranchSessionGuard />);
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it('redirects to /branch/select-employee when a branch session opens /branch/terminal', () => {
    mockPathname = '/branch/terminal';
    mockUser = { role: 'branch' };
    render(<BranchSessionGuard />);
    expect(mockReplace).toHaveBeenCalledWith('/branch/select-employee');
  });

  it('does not redirect a non-branch role (e.g. staff, already resolved to an employee) away from POS Terminal', () => {
    mockPathname = '/branch/terminal';
    mockUser = { role: 'staff' };
    render(<BranchSessionGuard />);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('never redirects the select-employee picker itself even for POS-adjacent paths', () => {
    mockPathname = '/branch/select-employee';
    mockUser = { role: 'branch' };
    render(<BranchSessionGuard />);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
