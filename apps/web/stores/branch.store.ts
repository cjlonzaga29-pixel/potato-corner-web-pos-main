import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ROLES, type BranchResponse } from '@potato-corner/shared';
import { useAuthStore } from './auth.store';

interface BranchState {
  activeBranchId: string | null;
  activeBranch: BranchResponse | null;
  /**
   * POS-PERF-P62 — the branch this tab had selected before a reload. Only a
   * hint: it becomes `activeBranchId` once the restored session's token shows
   * the user may open it (see the subscription below), so no request is sent
   * for a branch the session can't use. Cleared with the identity.
   */
  restoredBranchId: string | null;
  setActiveBranch: (branch: BranchResponse) => void;
  clearActiveBranch: () => void;
}

/**
 * Active branch context for multi-branch supervisors. Only `activeBranchId`
 * is persisted (to sessionStorage, so it survives a refresh but not a new
 * tab/session) — `activeBranch` is the full API object and is deliberately
 * left out of persistence so it can go stale; callers refetch it via
 * useBranch(activeBranchId) rather than trusting a cached snapshot.
 */
export const useBranchStore = create<BranchState>()(
  persist(
    (set) => ({
      activeBranchId: null,
      activeBranch: null,
      restoredBranchId: null,
      setActiveBranch: (branch) => set({ activeBranchId: branch.id, activeBranch: branch, restoredBranchId: null }),
      clearActiveBranch: () => set({ activeBranchId: null, activeBranch: null, restoredBranchId: null }),
    }),
    {
      name: 'potato-corner-active-branch',
      storage: createJSONStorage(() => sessionStorage),
      // Same stored shape as before P62, so a tab open across the upgrade keeps its selection.
      partialize: (state) => ({ activeBranchId: state.activeBranchId ?? state.restoredBranchId }),
      merge: (persisted, current) => {
        const stored = (persisted as { activeBranchId?: unknown } | undefined)?.activeBranchId;
        return { ...current, restoredBranchId: typeof stored === 'string' ? stored : null };
      },
    },
  ),
);

/** True when this session's token grants the branch (super admins: every branch). */
function sessionMayOpen(branchId: string): boolean {
  const { user, sessionStatus } = useAuthStore.getState();
  if (sessionStatus !== 'authenticated' || !user) return false;
  return user.role === ROLES.SUPER_ADMIN || user.branchIds.includes(branchId);
}

/**
 * Applies the reload hint once the session is known, and forgets every branch
 * selection when the identity changes (sign-out, or another account), so the
 * next account never starts on the previous one's branch.
 */
function applyRestoredBranch(): void {
  const { activeBranchId, restoredBranchId } = useBranchStore.getState();
  if (activeBranchId || !restoredBranchId) return;
  if (sessionMayOpen(restoredBranchId)) useBranchStore.setState({ activeBranchId: restoredBranchId, restoredBranchId: null });
}

useAuthStore.subscribe((state, previous) => {
  if (state.identityEpoch !== previous.identityEpoch) {
    useBranchStore.getState().clearActiveBranch();
    return;
  }
  if (state.sessionStatus === 'authenticated') applyRestoredBranch();
});
useBranchStore.persist?.onFinishHydration?.(applyRestoredBranch);
applyRestoredBranch();
