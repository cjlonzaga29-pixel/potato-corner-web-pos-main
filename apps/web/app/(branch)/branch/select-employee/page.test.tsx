import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import SelectEmployeePage from './page';

const { mockPush, mockReplace, mockUseAuth } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockUseAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SelectEmployeePage (Task 120: retired redirect shim)', () => {
  it('redirects a branch session straight to the POS Terminal, without authenticating as anyone else', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'branch' } });

    render(<SelectEmployeePage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/branch/terminal'));
  });

  it('redirects a staff session straight to the POS Terminal too', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'staff' } });

    render(<SelectEmployeePage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/branch/terminal'));
  });

  it('does not redirect while there is no authenticated user yet', () => {
    mockUseAuth.mockReturnValue({ user: null });

    render(<SelectEmployeePage />);

    expect(mockReplace).not.toHaveBeenCalled();
  });
});
