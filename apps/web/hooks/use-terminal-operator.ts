'use client';

import { useEffect } from 'react';
import { useIsClockedIn } from '@/hooks/queries/use-attendance';
import { useRefetchOnForeground } from '@/hooks/use-refetch-on-foreground';
import type { AttendanceResponse } from '@potato-corner/shared';
import { useTerminalOperatorStore } from '@/stores/terminal-operator.store';

export interface TerminalOperatorIdentity {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface UseTerminalOperatorArgs {
  isBranchAccount: boolean;
  branchId: string | null | undefined;
  userId: string | undefined;
  activeEmployee: TerminalOperatorIdentity | null;
  activeEmployeeToken: string | null;
  setActiveEmployee: (employee: TerminalOperatorIdentity | null) => void;
  setActiveEmployeeToken: (token: string | null) => void;
}

interface UseTerminalOperatorResult {
  operatorId: string | undefined;
  isClockedIn: boolean;
  record: AttendanceResponse | null;
  isAttendanceLoading: boolean;
  /**
   * True while a persisted terminal operator is being validated against live
   * attendance on mount — the caller must keep showing the existing loading
   * skeleton during this window instead of "Who's working?", so a still
   * clocked-in Employee is never flashed the picker before restoration
   * finishes.
   */
  isRestoringOperator: boolean;
  clearTerminalOperator: () => void;
}

/**
 * Task 209.27 — restores the POS Terminal's selected Employee (Branch
 * Account sessions only) after navigation/refresh, using the existing
 * per-employee attendance record (useIsClockedIn) as the sole source of
 * truth. terminal/page.tsx's own `activeEmployee` state still resets to
 * null on every remount (Task 120's terminal-local `useState` is
 * unchanged) — this hook re-populates it from the branch-scoped
 * sessionStorage hint in stores/terminal-operator.store.ts, but only after
 * confirming that Employee is still clocked in for this branch. A
 * persisted operator that is stale, clocked out, or scoped to a different
 * branch is dropped and never restored.
 */
export function useTerminalOperator({
  isBranchAccount,
  branchId,
  userId,
  activeEmployee,
  activeEmployeeToken,
  setActiveEmployee,
  setActiveEmployeeToken,
}: UseTerminalOperatorArgs): UseTerminalOperatorResult {
  const hasHydrated = useTerminalOperatorStore((s) => s.hasHydrated);
  const persistedBranchId = useTerminalOperatorStore((s) => s.branchId);
  const persistedEmployeeId = useTerminalOperatorStore((s) => s.employeeId);
  const persistedEmployeeToken = useTerminalOperatorStore((s) => s.employeeToken ?? null);
  const persistedFirstName = useTerminalOperatorStore((s) => s.firstName ?? '');
  const persistedLastName = useTerminalOperatorStore((s) => s.lastName ?? '');
  const persistedRole = useTerminalOperatorStore((s) => s.role ?? '');
  const setTerminalOperator = useTerminalOperatorStore((s) => s.setTerminalOperator);
  const clearTerminalOperator = useTerminalOperatorStore((s) => s.clearTerminalOperator);

  const hasPersistedCandidate =
    isBranchAccount && hasHydrated && persistedEmployeeId !== null && branchId != null && persistedBranchId === branchId;

  // Persisted operator belongs to a different branch than this session's —
  // never restore it here, and drop it so it can't linger for a future
  // branch match that would be coincidental, not intentional.
  useEffect(() => {
    if (!isBranchAccount || !hasHydrated || persistedEmployeeId === null || branchId == null) return;
    if (persistedBranchId !== branchId) clearTerminalOperator();
  }, [isBranchAccount, hasHydrated, persistedEmployeeId, persistedBranchId, branchId, clearTerminalOperator]);

  const restoreCandidateId = !activeEmployee && hasPersistedCandidate && persistedEmployeeId !== null ? persistedEmployeeId : undefined;
  const operatorId = isBranchAccount ? (activeEmployee?.id ?? restoreCandidateId) : userId;
  const { isClockedIn, record, isLoading: isAttendanceLoading, refetch: refetchAttendance } = useIsClockedIn(operatorId);
  // Server attendance state is authoritative — when this device's tab/app
  // regains the foreground, re-check it so a clock-out made from another
  // device (e.g. desktop) is picked up without a manual refresh.
  useRefetchOnForeground(refetchAttendance);

  useEffect(() => {
    if (!isBranchAccount || branchId == null || isAttendanceLoading) return;

    if (activeEmployee) {
      // Already have a confirmed local operator — keep the persisted hint in
      // sync while they're clocked in; self-heal it away the moment they
      // aren't (covers a clock-out triggered elsewhere, not just this tab's
      // own Clock Out button, which already clears it directly).
      if (isClockedIn) {
        if (persistedEmployeeId !== activeEmployee.id || persistedBranchId !== branchId || persistedEmployeeToken !== activeEmployeeToken) {
          setTerminalOperator({
            branchId,
            employeeId: activeEmployee.id,
            employeeToken: activeEmployeeToken,
            firstName: activeEmployee.firstName,
            lastName: activeEmployee.lastName,
            role: activeEmployee.role,
          });
        }
      } else if (persistedEmployeeId === activeEmployee.id) {
        clearTerminalOperator();
      }
      return;
    }

    if (!hasPersistedCandidate || persistedEmployeeId === null) return;
    if (isClockedIn) {
      setActiveEmployee({ id: persistedEmployeeId, firstName: persistedFirstName, lastName: persistedLastName, role: persistedRole });
      setActiveEmployeeToken(persistedEmployeeToken);
    } else {
      // Stale/clocked-out persisted operator — reject it (Part G/Part F).
      clearTerminalOperator();
    }
  }, [
    isBranchAccount,
    branchId,
    isAttendanceLoading,
    activeEmployee,
    isClockedIn,
    persistedEmployeeId,
    persistedBranchId,
    persistedEmployeeToken,
    persistedFirstName,
    persistedLastName,
    persistedRole,
    hasPersistedCandidate,
    activeEmployeeToken,
    setActiveEmployee,
    setActiveEmployeeToken,
    setTerminalOperator,
    clearTerminalOperator,
  ]);

  const isRestoringOperator = isBranchAccount && !activeEmployee && (!hasHydrated || (hasPersistedCandidate && isAttendanceLoading));

  return { operatorId, isClockedIn, record, isAttendanceLoading, isRestoringOperator, clearTerminalOperator };
}
