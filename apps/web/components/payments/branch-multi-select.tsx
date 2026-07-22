'use client';

import type { BranchResponse } from '@potato-corner/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/shared/feedback/empty-state';

interface BranchMultiSelectProps {
  branches: BranchResponse[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  search: string;
  onSearchChange: (value: string) => void;
  disabled?: boolean;
}

/** Checkbox list of branches with a search filter and a "select all" toggle, used for bulk GCash QR assignment. */
export function BranchMultiSelect({ branches, selectedIds, onChange, search, onSearchChange, disabled }: BranchMultiSelectProps) {
  const filtered = branches.filter((branch) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return branch.name.toLowerCase().includes(query) || branch.code.toLowerCase().includes(query);
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((branch) => selectedIds.includes(branch.id));

  function toggleAll() {
    const filteredIds = filtered.map((branch) => branch.id);
    if (allFilteredSelected) {
      onChange(selectedIds.filter((id) => !filteredIds.includes(id)));
    } else {
      onChange(Array.from(new Set([...selectedIds, ...filteredIds])));
    }
  }

  function toggleOne(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((existing) => existing !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  if (branches.length === 0) {
    return <EmptyState title="No branches available" description="Create a branch before assigning a GCash QR." />;
  }

  return (
    <div className="space-y-3">
      <Input placeholder="Search branches..." value={search} onChange={(event) => onSearchChange(event.target.value)} disabled={disabled} />

      <div className="flex items-center gap-2 border-b pb-2">
        <Checkbox
          id="select-all-branches"
          checked={allFilteredSelected}
          onCheckedChange={toggleAll}
          disabled={disabled || filtered.length === 0}
        />
        <Label htmlFor="select-all-branches" className="text-sm font-medium">
          Select all {filtered.length > 0 ? `(${filtered.length})` : ''}
        </Label>
        <span className="ml-auto text-xs text-muted-foreground">{selectedIds.length} selected</span>
      </div>

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No branches match &quot;{search}&quot;</p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {filtered.map((branch) => (
            <div key={branch.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Checkbox
                id={`branch-${branch.id}`}
                checked={selectedIds.includes(branch.id)}
                onCheckedChange={() => toggleOne(branch.id)}
                disabled={disabled}
              />
              <Label htmlFor={`branch-${branch.id}`} className="flex-1 cursor-pointer text-sm font-normal">
                {branch.name} <span className="text-muted-foreground">({branch.code})</span>
              </Label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
