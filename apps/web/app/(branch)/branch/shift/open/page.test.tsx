import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ROLES } from '@potato-corner/shared';
import OpenShiftPage from './page';

const {
  mockPush,
  mockReplace,
  mockUseAuth,
  mockUseEmployees,
  mockUseOpenShift,
  mockMutateAsync,
  mockUseIsClockedIn,
  mockUseMyActiveShift,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseEmployees: vi.fn(),
  mockUseOpenShift: vi.fn(),
  mockMutateAsync: vi.fn(),
  mockUseIsClockedIn: vi.fn(),
  mockUseMyActiveShift: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: vi.fn() }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useIsClockedIn: mockUseIsClockedIn,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useOpenShift: mockUseOpenShift,
  useMyActiveShift: mockUseMyActiveShift,
  useShiftsRealtimeSync: () => undefined,
}));

// Radix Select doesn't render/interact reliably under jsdom (no pointer
// capture / scrollIntoView) — same stand-in pattern used by
// app/(branch)/branch/terminal/page.test.tsx: a plain div carrying
// data-disabled so tests can assert the lock, and SelectItems as buttons.
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});
  function Select({
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) {
    return (
      <SelectContext.Provider value={{ onValueChange }}>
        <div data-testid="cashier-select" data-disabled={disabled ? 'true' : 'false'}>
          {children}
        </div>
      </SelectContext.Provider>
    );
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

// formSchema validates cashier_id as z.uuid() — non-UUID test ids fail
// client-side validation silently (onSubmit never fires), so fixtures here
// use real-shaped UUIDs rather than short readable stand-ins.
const STAFF_1 = 'd8c33b6a-8bdb-4116-ae2f-cbf939ebaa59';
const STAFF_2 = '62a62ff3-f435-4e5b-a3ec-5167427c3dff';
const SUPER_1 = '7e2f9b34-1c1a-4f2d-9c3a-6b8a2e5d4f10';
const BRANCH_1 = '3a1e7c2d-5b6f-4a8e-9d0c-1f2b3a4c5d6e';

function staffMember(overrides: Record<string, unknown> = {}) {
  return {
    id: STAFF_2,
    first_name: 'Other',
    last_name: 'Cashier',
    email: 'other@example.com',
    ...overrides,
  };
}

function fillOneDenomination(container: HTMLElement) {
  const input = container.querySelector('input[type="number"]');
  if (!input) throw new Error('No denomination input found');
  fireEvent.change(input, { target: { value: '5' } });
}

function mockNotClockedIn() {
  mockUseIsClockedIn.mockReturnValue({ isClockedIn: false, isLoading: false });
}

function mockClockedIn() {
  mockUseIsClockedIn.mockReturnValue({ isClockedIn: true, isLoading: false });
}

function mockNoActiveShift() {
  mockUseMyActiveShift.mockReturnValue({ shift: null, isMine: false, belongsToAnother: false, isLoading: false });
}

function mockMyActiveShift() {
  mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isMine: true, belongsToAnother: false, isLoading: false });
}

function mockAnotherCashiersActiveShift() {
  mockUseMyActiveShift.mockReturnValue({ shift: { id: 'shift-1' }, isMine: false, belongsToAnother: true, isLoading: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OpenShiftPage', () => {
  it('a staff member opens their own shift — cashier_id defaults to and submits as their own id', async () => {
    mockUseAuth.mockReturnValue({
      user: { id: STAFF_1, role: ROLES.STAFF, branchIds: [BRANCH_1], firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    mockMutateAsync.mockResolvedValue({ id: 'shift-1' });
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockClockedIn();
    mockNoActiveShift();

    const { container } = render(<OpenShiftPage />);
    fillOneDenomination(container);
    fireEvent.click(screen.getByRole('button', { name: /open shift/i }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ cashier_id: STAFF_1, branch_id: BRANCH_1 })),
    );
    expect(mockPush).toHaveBeenCalledWith('/branch/terminal');
  });

  it('does not submit a second open-shift request on a rapid double click', async () => {
    mockUseAuth.mockReturnValue({
      user: { id: STAFF_1, role: ROLES.STAFF, branchIds: [BRANCH_1], firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    // Never resolves — the assertion only cares how many times mutateAsync
    // was invoked, not what happens after.
    mockMutateAsync.mockReturnValue(new Promise(() => {}));
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockClockedIn();
    mockNoActiveShift();

    const { container } = render(<OpenShiftPage />);
    fillOneDenomination(container);
    const submitButton = screen.getByRole('button', { name: /open shift/i });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    // Flush react-hook-form's async validation/submit microtasks for all
    // three clicks before asserting — waitFor would stop at the first
    // passing check, which could be a false pass if click #2/#3 hadn't run yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('redirects to Clock In when the cashier has not clocked in — the opening form is never shown', () => {
    mockUseAuth.mockReturnValue({
      user: { id: STAFF_1, role: ROLES.STAFF, branchIds: [BRANCH_1], firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockNotClockedIn();
    mockNoActiveShift();

    render(<OpenShiftPage />);

    expect(mockReplace).toHaveBeenCalledWith('/branch/clock-in');
    expect(screen.queryByText('Open Shift')).not.toBeInTheDocument();
  });

  it('redirects straight to POS when the cashier already has an active shift — no second opening form', () => {
    mockUseAuth.mockReturnValue({
      user: { id: STAFF_1, role: ROLES.STAFF, branchIds: [BRANCH_1], firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockClockedIn();
    mockMyActiveShift();

    render(<OpenShiftPage />);

    expect(mockReplace).toHaveBeenCalledWith('/branch/terminal');
    expect(screen.queryByRole('button', { name: /^open shift$/i })).not.toBeInTheDocument();
  });

  it('blocks opening a second shift when the branch already has one active under a different cashier', () => {
    mockUseAuth.mockReturnValue({
      user: { id: STAFF_1, role: ROLES.STAFF, branchIds: [BRANCH_1], firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockClockedIn();
    mockAnotherCashiersActiveShift();

    render(<OpenShiftPage />);

    expect(screen.getByText(/already has an active shift open under a different cashier/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^open shift$/i })).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('a staff member cannot select another cashier — the selector is locked and no other staff are offered', () => {
    mockUseAuth.mockReturnValue({
      user: { id: STAFF_1, role: ROLES.STAFF, branchIds: [BRANCH_1], firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockClockedIn();
    mockNoActiveShift();

    render(<OpenShiftPage />);

    expect(screen.getByTestId('cashier-select')).toHaveAttribute('data-disabled', 'true');
    expect(screen.queryByText('Other Cashier')).not.toBeInTheDocument();
    expect(screen.getByText(/shifts must be opened under your own account/i)).toBeInTheDocument();
  });

  it('a supervisor can select another cashier and opens a shift on their behalf', async () => {
    mockUseAuth.mockReturnValue({
      user: { id: SUPER_1, role: ROLES.SUPERVISOR, branchIds: [BRANCH_1], firstName: 'Sam', lastName: 'Super', email: 'sam@example.com' },
    });
    mockUseEmployees.mockReturnValue({ data: { employees: [staffMember()] } });
    mockMutateAsync.mockResolvedValue({ id: 'shift-1' });
    mockUseOpenShift.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockClockedIn();
    mockNoActiveShift();

    const { container } = render(<OpenShiftPage />);

    expect(screen.getByTestId('cashier-select')).toHaveAttribute('data-disabled', 'false');
    fireEvent.click(screen.getByText('Other Cashier'));
    fillOneDenomination(container);
    fireEvent.click(screen.getByRole('button', { name: /open shift/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ cashier_id: STAFF_2 })));
  });
});
