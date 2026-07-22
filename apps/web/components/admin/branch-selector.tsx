'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSelectedBranch } from '@/hooks/use-selected-branch';

const ALL_BRANCHES = 'all';

/** Dashboard-wide branch scope picker — a read-only label for single-branch users, a dropdown otherwise. */
export function BranchSelector() {
  const { selectedBranchId, setSelectedBranch, availableBranches, allLabel, isSingleBranchUser } = useSelectedBranch();

  if (isSingleBranchUser) {
    const branchName = availableBranches[0]?.name ?? 'Your branch';
    return <div className="text-sm font-medium text-muted-foreground">{branchName}</div>;
  }

  return (
    <Select value={selectedBranchId} onValueChange={setSelectedBranch}>
      <SelectTrigger className="w-64">
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_BRANCHES}>{allLabel}</SelectItem>
        {availableBranches.map((branch) => (
          <SelectItem key={branch.id} value={branch.id}>
            {branch.name} <span className="text-muted-foreground">({branch.code})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
