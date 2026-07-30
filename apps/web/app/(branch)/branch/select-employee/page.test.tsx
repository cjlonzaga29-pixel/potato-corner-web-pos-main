import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import SelectEmployeePage from './page';

const { mockPush, mockReplace, mockUseAuth, mockSelectEmployee, mockUseEmployees } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockUseAuth: vi.fn(),
  mockSelectEmployee: vi.fn(),
  mockUseEmployees: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
}));

function employee(overrides: Record<string, unknown> = {}) {
  return {
    id: 'employee-1',
    first_name: 'Jane',
    last_name: 'Doe',
    position: 'Cashier',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SelectEmployeePage', () => {
  it('routes to Clock In (not the dashboard) after selecting an employee', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'branch' }, selectEmployee: mockSelectEmployee });
    mockSelectEmployee.mockResolvedValue({ id: 'employee-1' });
    mockUseEmployees.mockReturnValue({
      data: { employees: [employee()] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<SelectEmployeePage />);
    fireEvent.click(screen.getByText('Jane Doe'));

    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalledWith('employee-1'));
    expect(mockPush).toHaveBeenCalledWith('/branch/clock-in');
    expect(mockPush).not.toHaveBeenCalledWith('/branch/dashboard');
  });

  it('does not attempt navigation when selecting an employee fails', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'branch' }, selectEmployee: mockSelectEmployee });
    mockSelectEmployee.mockRejectedValue(new Error('Employee is not active'));
    mockUseEmployees.mockReturnValue({
      data: { employees: [employee()] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<SelectEmployeePage />);
    fireEvent.click(screen.getByText('Jane Doe'));

    await waitFor(() => expect(mockSelectEmployee).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });
});
