import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalOperatorStore } from './terminal-operator.store';

const OPERATOR = {
  branchId: 'branch-1',
  employeeId: 'employee-1',
  employeeToken: 'employee-token',
  firstName: 'Jane',
  lastName: 'Doe',
  role: 'staff',
};

beforeEach(() => {
  sessionStorage.clear();
  useTerminalOperatorStore.setState({
    branchId: null,
    employeeId: null,
    employeeToken: null,
    firstName: undefined,
    lastName: undefined,
    role: undefined,
  });
});

describe('useTerminalOperatorStore', () => {
  it('defaults to no persisted operator', () => {
    const state = useTerminalOperatorStore.getState();
    expect(state.branchId).toBeNull();
    expect(state.employeeId).toBeNull();
    expect(state.employeeToken).toBeNull();
  });

  it('setTerminalOperator stores the full identity', () => {
    useTerminalOperatorStore.getState().setTerminalOperator(OPERATOR);
    const state = useTerminalOperatorStore.getState();
    expect(state.branchId).toBe('branch-1');
    expect(state.employeeId).toBe('employee-1');
    expect(state.employeeToken).toBe('employee-token');
    expect(state.firstName).toBe('Jane');
    expect(state.lastName).toBe('Doe');
    expect(state.role).toBe('staff');
  });

  it('clearTerminalOperator wipes every field', () => {
    useTerminalOperatorStore.getState().setTerminalOperator(OPERATOR);
    useTerminalOperatorStore.getState().clearTerminalOperator();
    const state = useTerminalOperatorStore.getState();
    expect(state.branchId).toBeNull();
    expect(state.employeeId).toBeNull();
    expect(state.employeeToken).toBeNull();
    expect(state.firstName).toBeUndefined();
  });

  it('persists to sessionStorage under the potato-corner-terminal-operator key', () => {
    useTerminalOperatorStore.getState().setTerminalOperator(OPERATOR);
    const raw = sessionStorage.getItem('potato-corner-terminal-operator');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.employeeId).toBe('employee-1');
  });

  it('survives a store re-init by rehydrating from sessionStorage (simulates navigation/remount)', () => {
    useTerminalOperatorStore.getState().setTerminalOperator(OPERATOR);
    useTerminalOperatorStore.persist.rehydrate();
    const state = useTerminalOperatorStore.getState();
    expect(state.employeeId).toBe('employee-1');
    expect(state.branchId).toBe('branch-1');
  });
});
