'use client';

import { useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useBranch } from '@/hooks/queries/use-branches';
import { useBranchStore } from '@/stores/branch.store';

/**
 * A `branch`/`staff` account is bound to exactly one branch (the first
 * entry in the JWT's branch_ids — see (branch)/layout.tsx's doc comment),
 * never a client-side selection. Every branch-ops page reused from the
 * supervisor route tree (inventory, employees, attendance, cash, expenses,
 * recipes, reports) reads its active branch from useBranchStore, which is
 * otherwise only ever populated by the supervisor sidebar's BranchSelector.
 * This mounts once in the branch shell to seed that same store from the
 * JWT, so those shared components work unmodified under /branch/* without
 * a selector ever being rendered.
 */
export function BranchContextSync() {
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { data: branch } = useBranch(branchId);
  const setActiveBranch = useBranchStore((s) => s.setActiveBranch);
  const activeBranchId = useBranchStore((s) => s.activeBranchId);

  useEffect(() => {
    if (branch && branch.id !== activeBranchId) {
      setActiveBranch(branch);
    }
  }, [branch, activeBranchId, setActiveBranch]);

  return null;
}
