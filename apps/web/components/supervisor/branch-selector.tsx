'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { ROLES, type BranchResponse } from '@potato-corner/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useBranch } from '@/hooks/use-branch';
import { useBranches } from '@/hooks/queries/use-branches';
import { useAuthStore } from '@/stores/auth.store';

/**
 * GET /api/branches already scopes results to the requesting supervisor's
 * branch_ids server-side (branches.service.ts's getAllBranches) — no
 * client-side filtering against the auth store is needed here, the API
 * response IS the supervisor's assigned-branch list.
 */
export function BranchSelector() {
  const { activeBranchId, activeBranch, setActiveBranch } = useBranch();
  const { data, isLoading } = useBranches({ limit: 100 });
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const allBranches = data?.branches ?? [];
  const branches =
    user?.role === ROLES.SUPERVISOR
      ? allBranches.filter((branch) => user.branchIds.includes(branch.id))
      : allBranches;

  useEffect(() => {
    if (!activeBranchId && branches.length > 0) {
      setActiveBranch(branches[0] as BranchResponse);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranchId, branches.length]);

  if (isLoading) {
    return <LoadingSpinner size="sm" />;
  }

  if (branches.length === 0) return null;

  const selected = activeBranch ?? branches.find((branch) => branch.id === activeBranchId) ?? branches[0];

  function handleSelect(branch: BranchResponse) {
    setActiveBranch(branch);
    // Every supervisor feature scopes its queries under ['branch', id, ...]
    // — invalidating the whole 'branch' query family forces a refetch
    // under the newly active branch id.
    void queryClient.invalidateQueries({ queryKey: ['branch'] });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          <span className="truncate">{selected?.name ?? 'Select branch'}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {branches.map((branch) => (
          <DropdownMenuItem key={branch.id} onClick={() => handleSelect(branch as BranchResponse)}>
            <div className="flex flex-col">
              <span>{branch.name}</span>
              <span className="text-xs text-muted-foreground">{branch.code}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
