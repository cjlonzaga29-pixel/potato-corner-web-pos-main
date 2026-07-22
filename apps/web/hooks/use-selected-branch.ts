'use client';

import { useEffect, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { ROLES } from '@potato-corner/shared';
import { useAuth } from '@/hooks/use-auth';
import { useBranches } from '@/hooks/queries/use-branches';
import { useSelectedBranchStore } from '@/stores/selected-branch.store';

const ALL_BRANCHES = 'all';

/**
 * Facade over the selected-branch store: resolves which branches the current
 * user may pick from (role-scoped), keeps the `branch_id` URL param and the
 * persisted store selection in sync, and flags single-branch users so the
 * caller can render a read-only label instead of a dropdown.
 */
export function useSelectedBranch() {
  const { user } = useAuth();
  const { selectedBranchId, setSelectedBranch: setStoreBranch } = useSelectedBranchStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const appliedUrlOverride = useRef(false);

  const { data: branchesData } = useBranches({ status: 'active', limit: 100 });
  const allBranches = branchesData?.branches ?? [];

  const isSuperAdmin = user?.role === ROLES.SUPER_ADMIN;
  const branchIds = user?.branchIds ?? [];

  const availableBranches = isSuperAdmin ? allBranches : allBranches.filter((b) => branchIds.includes(b.id));
  const allLabel = isSuperAdmin ? 'All Branches' : 'All my branches';
  const isSingleBranchUser = !isSuperAdmin && branchIds.length === 1;

  function setSelectedBranch(id: string) {
    setStoreBranch(id);
    const params = new URLSearchParams(searchParams.toString());
    if (id === ALL_BRANCHES) {
      params.delete('branch_id');
    } else {
      params.set('branch_id', id);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  useEffect(() => {
    if (appliedUrlOverride.current) return;
    appliedUrlOverride.current = true;

    const paramBranchId = searchParams.get('branch_id');
    if (paramBranchId) {
      setSelectedBranch(paramBranchId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    selectedBranchId,
    setSelectedBranch,
    availableBranches,
    allLabel,
    isSingleBranchUser,
  };
}
