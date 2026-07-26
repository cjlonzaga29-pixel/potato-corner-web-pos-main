'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import type { BranchResponse } from '@potato-corner/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useBranch } from '@/hooks/use-branch';
import { useBranches } from '@/hooks/queries/use-branches';

/**
 * GET /api/branches?status=active already scopes results to the requesting
 * supervisor's branch_ids server-side (branches.service.ts's
 * getAllBranches, driven by lib/branch-access.ts's getAccessibleBranchIds)
 * — the API response IS the supervisor's assigned-branch list, so no
 * client-side re-filtering against the auth store's cached branchIds
 * happens here. That cached copy can legitimately lag the server (it's only
 * refreshed on login/token-refresh/a realtime assignment push), and
 * re-filtering against it would silently hide a branch the API already
 * confirmed the supervisor can access — e.g. one just assigned by Super
 * Admin whose realtime refresh hasn't landed yet.
 */
export function BranchSelector() {
  const { activeBranchId, activeBranch, setActiveBranch } = useBranch();
  const { data, isLoading } = useBranches({ status: 'active', limit: 100 });
  const queryClient = useQueryClient();
  const branches = data?.branches ?? [];

  useEffect(() => {
    if (isLoading) return;
    if (branches.length === 0) return;
    // Covers both "nothing selected yet" and "the previously selected
    // branch is no longer in this accessible/active list" (removed
    // assignment, closed branch, or a stale id left over from a prior
    // session) — either way, fall back to the first accessible branch and
    // persist that as the new active branch via the existing store.
    const activeIdStillValid = branches.some((branch) => branch.id === activeBranchId);
    if (!activeIdStillValid) {
      setActiveBranch(branches[0] as BranchResponse);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranchId, branches, isLoading]);

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
        <Button variant="outline" size="sm" className="w-full min-w-0 justify-between">
          <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? 'Select branch'}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {branches.map((branch) => (
          <DropdownMenuItem key={branch.id} onClick={() => handleSelect(branch as BranchResponse)}>
            <div className="flex min-w-0 w-full flex-col">
              <span className="truncate">{branch.name}</span>
              <span className="truncate text-xs text-muted-foreground">{branch.code}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
