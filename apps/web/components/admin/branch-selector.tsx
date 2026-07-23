'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSelectedBranch } from '@/hooks/use-selected-branch';

const ALL_BRANCHES = 'all';

/** Dashboard-wide branch scope picker — a read-only label for single-branch users, a plain dropdown otherwise. */
export function BranchSelector() {
  const { selectedBranchId, setSelectedBranch, availableBranches, allLabel, isSingleBranchUser } = useSelectedBranch();

  if (isSingleBranchUser) {
    const branchName = availableBranches[0]?.name ?? 'Your branch';
    return <div className="text-sm font-medium text-muted-foreground">{branchName}</div>;
  }

  return (
    <Select value={selectedBranchId} onValueChange={setSelectedBranch}>
      <SelectTrigger className="h-10 w-64 rounded-lg px-4 text-sm font-medium">
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent className="max-h-72 rounded-xl p-1.5">
        <SelectItem value={ALL_BRANCHES} className="rounded-lg py-2.5 font-medium">
          {allLabel}
        </SelectItem>
        <div className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto border-t pt-1.5">
          {availableBranches.map((branch) => (
            <SelectItem key={branch.id} value={branch.id} className="rounded-lg py-2.5">
              {branch.name} <span className="text-muted-foreground">({branch.code})</span>
            </SelectItem>
          ))}
        </div>
      </SelectContent>
    </Select>
  );
}
