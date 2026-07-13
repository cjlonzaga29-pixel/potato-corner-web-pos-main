import { useBranchStore } from '@/stores/branch.store';

/** Active branch context for multi-branch supervisors. */
export function useBranch() {
  const { activeBranchId, activeBranch, setActiveBranch, clearActiveBranch } = useBranchStore();
  return { activeBranchId, activeBranch, setActiveBranch, clearActiveBranch };
}
