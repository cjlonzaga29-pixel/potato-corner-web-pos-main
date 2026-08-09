import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { useTerminalOperator } from './use-terminal-operator';
import { useTerminalOperatorStore } from '@/stores/terminal-operator.store';

const { mockUseIsClockedIn } = vi.hoisted(() => ({
  mockUseIsClockedIn: vi.fn(),
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useIsClockedIn: mockUseIsClockedIn,
}));

function clockedIn(record: unknown = { clock_in_server_time: '2026-01-01T08:00:00.000Z' }) {
  return { isClockedIn: true, record, isLoading: false };
}
function clockedOut() {
  return { isClockedIn: false, record: null, isLoading: false };
}
function loading() {
  return { isClockedIn: false, record: null, isLoading: true };
}

function renderTerminalOperator(overrides: Partial<Parameters<typeof useTerminalOperator>[0]> = {}) {
  const setActiveEmployee = vi.fn();
  const setActiveEmployeeToken = vi.fn();
  const view = renderHook((props: Parameters<typeof useTerminalOperator>[0]) => useTerminalOperator(props), {
    initialProps: {
      isBranchAccount: true,
      branchId: 'branch-1',
      userId: undefined,
      activeEmployee: null,
      activeEmployeeToken: null,
      setActiveEmployee,
      setActiveEmployeeToken,
      ...overrides,
    },
  });
  return { ...view, setActiveEmployee, setActiveEmployeeToken };
}

beforeEach(() => {
  sessionStorage.clear();
  useTerminalOperatorStore.setState({
    branchId: null,
    employeeId: null,
    employeeToken: null,
    firstName: undefined,
    lastName: undefined,
    role: undefined,
    hasHydrated: true,
  });
  mockUseIsClockedIn.mockReset();
});

afterEach(() => cleanup());

describe('useTerminalOperator', () => {
  it('1. no persisted operator -> not restoring, no candidate to restore', () => {
    mockUseIsClockedIn.mockReturnValue(clockedOut());
    const { result } = renderTerminalOperator();
    expect(result.current.isRestoringOperator).toBe(false);
    expect(result.current.operatorId).toBeUndefined();
  });

  it('2. restores a persisted operator who is still clocked in', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedIn());

    const { setActiveEmployee, setActiveEmployeeToken } = renderTerminalOperator();

    await waitFor(() => expect(setActiveEmployee).toHaveBeenCalledWith({ id: 'employee-1', firstName: 'Jane', lastName: 'Doe', role: 'staff' }));
    expect(setActiveEmployeeToken).toHaveBeenCalledWith('employee-token');
  });

  it('3. re-mount (simulated) restores the same operator again from sessionStorage', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedIn());

    const first = renderTerminalOperator();
    await waitFor(() => expect(first.setActiveEmployee).toHaveBeenCalled());
    first.unmount();

    // A fresh mount (route remount) with fresh terminal-local React state,
    // but the same sessionStorage-backed store.
    const second = renderTerminalOperator();
    await waitFor(() => expect(second.setActiveEmployee).toHaveBeenCalledWith({ id: 'employee-1', firstName: 'Jane', lastName: 'Doe', role: 'staff' }));
  });

  it('4. does not flash "no operator" while hydration/attendance validation is still pending', () => {
    useTerminalOperatorStore.setState({ hasHydrated: false });
    mockUseIsClockedIn.mockReturnValue(loading());

    const { result } = renderTerminalOperator();
    expect(result.current.isRestoringOperator).toBe(true);
  });

  it('5. rejects a stale persisted operator (attendance says not clocked in) and clears it', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedOut());

    const { result, setActiveEmployee } = renderTerminalOperator();

    await waitFor(() => expect(useTerminalOperatorStore.getState().employeeId).toBeNull());
    expect(setActiveEmployee).not.toHaveBeenCalled();
    expect(result.current.isRestoringOperator).toBe(false);
  });

  it('6. clocked-out operator (explicit) is rejected the same way as stale', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-2',
      employeeToken: 'employee-2-token',
      firstName: 'Sam',
      lastName: 'Reyes',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedOut());

    renderTerminalOperator();

    await waitFor(() => expect(useTerminalOperatorStore.getState().employeeId).toBeNull());
  });

  it('7. clearTerminalOperator (Clock Out) removes the persisted operator so it cannot be restored again', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedIn());

    const { result } = renderTerminalOperator();
    result.current.clearTerminalOperator();

    expect(useTerminalOperatorStore.getState().employeeId).toBeNull();
    expect(useTerminalOperatorStore.getState().employeeToken).toBeNull();
  });

  it('8. multiple clocked-in employees: only restores the specific persisted operator, never an arbitrary one', async () => {
    // Persisted operator is employee-1. Attendance is queried per specific
    // employee id (never "any clocked-in employee at this branch"), so a
    // second employee-2 also being clocked in elsewhere cannot influence
    // which id useIsClockedIn is even called with.
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-1',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedIn());

    renderTerminalOperator();

    await waitFor(() => expect(mockUseIsClockedIn).toHaveBeenCalledWith('employee-1'));
    expect(mockUseIsClockedIn).not.toHaveBeenCalledWith('employee-2');
  });

  it('9. persisted operator scoped to another branch is rejected without restoring', async () => {
    useTerminalOperatorStore.getState().setTerminalOperator({
      branchId: 'branch-2',
      employeeId: 'employee-1',
      employeeToken: 'employee-token',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'staff',
    });
    mockUseIsClockedIn.mockReturnValue(clockedOut());

    const { result, setActiveEmployee } = renderTerminalOperator({ branchId: 'branch-1' });

    await waitFor(() => expect(useTerminalOperatorStore.getState().employeeId).toBeNull());
    expect(setActiveEmployee).not.toHaveBeenCalled();
    expect(result.current.isRestoringOperator).toBe(false);
    expect(result.current.operatorId).toBeUndefined();
  });

  it('10. does not treat "restoring" as done until hydration has actually completed', () => {
    useTerminalOperatorStore.setState({ hasHydrated: false, employeeId: null });
    mockUseIsClockedIn.mockReturnValue(clockedOut());

    const { result } = renderTerminalOperator();
    // No persisted candidate exists once hydrated, but hydration itself
    // hasn't resolved yet -> still restoring, never falls straight to "no operator".
    expect(result.current.isRestoringOperator).toBe(true);
  });

  it('a genuine staff login (not a branch account) is never subject to restoration', () => {
    mockUseIsClockedIn.mockReturnValue(clockedIn());
    const { result } = renderTerminalOperator({ isBranchAccount: false, userId: 'staff-1', branchId: 'branch-1' });
    expect(result.current.operatorId).toBe('staff-1');
    expect(result.current.isRestoringOperator).toBe(false);
  });
});
