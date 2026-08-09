import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface TerminalOperatorRecord {
  branchId: string;
  employeeId: string;
  employeeToken: string | null;
  firstName: string;
  lastName: string;
  role: string;
}

interface TerminalOperatorState extends Partial<Omit<TerminalOperatorRecord, 'employeeId' | 'branchId'>> {
  branchId: string | null;
  employeeId: string | null;
  hasHydrated: boolean;
  setTerminalOperator: (operator: TerminalOperatorRecord) => void;
  clearTerminalOperator: () => void;
  setHasHydrated: (hydrated: boolean) => void;
}

/**
 * Task 209.27 — which Employee is running the POS Terminal on this
 * device/tab, persisted to sessionStorage so returning to /branch/terminal
 * (navigation or refresh) doesn't force "Who's working?" again while that
 * Employee is still clocked in.
 *
 * This is an IDENTITY hint only, not an authorization grant — it never
 * bypasses attendance. use-terminal-operator.ts always re-validates
 * employeeId against the live attendance record before trusting it, and
 * drops it the moment that check fails (clocked out elsewhere, stale, or
 * scoped to a different branch). See Task 209.27 report Part K.
 */
export const useTerminalOperatorStore = create<TerminalOperatorState>()(
  persist(
    (set) => ({
      branchId: null,
      employeeId: null,
      employeeToken: null,
      firstName: undefined,
      lastName: undefined,
      role: undefined,
      hasHydrated: false,
      setTerminalOperator: (operator) =>
        set({
          branchId: operator.branchId,
          employeeId: operator.employeeId,
          employeeToken: operator.employeeToken,
          firstName: operator.firstName,
          lastName: operator.lastName,
          role: operator.role,
        }),
      clearTerminalOperator: () =>
        set({ branchId: null, employeeId: null, employeeToken: null, firstName: undefined, lastName: undefined, role: undefined }),
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),
    }),
    {
      name: 'potato-corner-terminal-operator',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        branchId: state.branchId,
        employeeId: state.employeeId,
        employeeToken: state.employeeToken,
        firstName: state.firstName,
        lastName: state.lastName,
        role: state.role,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
