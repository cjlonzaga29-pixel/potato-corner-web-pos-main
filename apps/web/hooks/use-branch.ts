import { useBranchStore } from '@/stores/branch.store';

/** Active branch context for multi-branch supervisors. */
export function useBranch() {
  const { activeBranchId, activeBranch, restoredBranchId, setActiveBranch, clearActiveBranch } = useBranchStore();
  return { activeBranchId, activeBranch, restoredBranchId, setActiveBranch, clearActiveBranch };
}
