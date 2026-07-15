import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { BranchResponse } from '@potato-corner/shared';

interface BranchState {
  activeBranchId: string | null;
  activeBranch: BranchResponse | null;
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
      setActiveBranch: (branch) => set({ activeBranchId: branch.id, activeBranch: branch }),
      clearActiveBranch: () => set({ activeBranchId: null, activeBranch: null }),
    }),
    {
      name: 'potato-corner-active-branch',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ activeBranchId: state.activeBranchId }),
    },
  ),
);
