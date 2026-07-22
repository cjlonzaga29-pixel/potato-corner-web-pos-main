'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useBranches } from '@/hooks/queries/use-branches';
import type { ExpenseCategory } from '@/hooks/queries/use-expenses';

const ALL_BRANCHES = 'all';
const ALL_CATEGORIES = 'all';

const CATEGORY_OPTIONS: { value: ExpenseCategory; label: string }[] = [
  { value: 'utilities', label: 'Utilities' },
  { value: 'supplies', label: 'Supplies' },
  { value: 'staff_meals', label: 'Staff Meals' },
  { value: 'miscellaneous', label: 'Miscellaneous' },
];

export interface ExpenseFilterValues {
  branchId: string;
  category: string;
  dateFrom: string;
  dateTo: string;
}

export interface ExpenseFilterBarProps {
  filters: ExpenseFilterValues;
  onChange: (updates: Partial<Record<'branch_id' | 'category' | 'date_from' | 'date_to', string | null>>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}

export function ExpenseFilterBar({ filters, onChange, onClear, hasActiveFilters }: ExpenseFilterBarProps) {
  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <Label htmlFor="expense-branch-filter">Branch</Label>
        <Select value={filters.branchId} onValueChange={(value) => onChange({ branch_id: value })}>
          <SelectTrigger id="expense-branch-filter" className="w-[220px]" disabled={isBranchesLoading}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
            {branches.map((branch) => (
              <SelectItem key={branch.id} value={branch.id}>
                {branch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="expense-category-filter">Category</Label>
        <Select value={filters.category} onValueChange={(value) => onChange({ category: value })}>
          <SelectTrigger id="expense-category-filter" className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
            {CATEGORY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="expense-date-from-filter">Date From</Label>
        <Input
          id="expense-date-from-filter"
          type="date"
          className="w-[170px]"
          value={filters.dateFrom}
          onChange={(e) => onChange({ date_from: e.target.value || null })}
        />
      </div>

      <div>
        <Label htmlFor="expense-date-to-filter">Date To</Label>
        <Input
          id="expense-date-to-filter"
          type="date"
          className="w-[170px]"
          value={filters.dateTo}
          onChange={(e) => onChange({ date_to: e.target.value || null })}
        />
      </div>

      {hasActiveFilters && (
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
