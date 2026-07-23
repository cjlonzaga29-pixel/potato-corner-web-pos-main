'use client';

import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useSelectedBranch } from '@/hooks/use-selected-branch';

const ALL_BRANCHES = 'all';

/** Dashboard-wide branch scope picker — a read-only label for single-branch users, a searchable dropdown otherwise. */
export function BranchSelector() {
  const { selectedBranchId, setSelectedBranch, availableBranches, allLabel, isSingleBranchUser } = useSelectedBranch();
  const [search, setSearch] = useState('');

  if (isSingleBranchUser) {
    const branchName = availableBranches[0]?.name ?? 'Your branch';
    return <div className="text-sm font-medium text-muted-foreground">{branchName}</div>;
  }

  const query = search.trim().toLowerCase();
  const filteredBranches = query
    ? availableBranches.filter(
        (branch) => branch.name.toLowerCase().includes(query) || branch.code.toLowerCase().includes(query),
      )
    : availableBranches;

  return (
    <Select
      value={selectedBranchId}
      onValueChange={setSelectedBranch}
      onOpenChange={(open) => {
        if (!open) setSearch('');
      }}
    >
      <SelectTrigger className="w-64">
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <div className="sticky top-0 z-10 bg-popover p-1">
          <Input
            placeholder="Search branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-8"
          />
        </div>
        <SelectItem value={ALL_BRANCHES}>{allLabel}</SelectItem>
        <div className="max-h-56 overflow-y-auto">
          {filteredBranches.map((branch) => (
            <SelectItem key={branch.id} value={branch.id}>
              {branch.name} <span className="text-muted-foreground">({branch.code})</span>
            </SelectItem>
          ))}
          {filteredBranches.length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">No branches match &quot;{search}&quot;</p>
          )}
        </div>
      </SelectContent>
    </Select>
  );
}
