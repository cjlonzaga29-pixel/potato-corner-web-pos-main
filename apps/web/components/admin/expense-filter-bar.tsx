'use client';

import { EXPENSE_CATEGORY_LABELS, legacyExpenseCategoryLabel } from '@potato-corner/shared';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useBranches } from '@/hooks/queries/use-branches';
import { useExpenseTypes } from '@/hooks/queries/use-expense-types';

const ALL_BRANCHES = 'all';
const ALL_TYPES = 'all';

export interface ExpenseFilterValues {
  branchId: string;
  /** ALL_TYPES, `type:<id>` or `legacy:<category>`. */
  typeFilter: string;
  dateFrom: string;
  dateTo: string;
}

export interface ExpenseFilterBarProps {
  filters: ExpenseFilterValues;
  onChange: (updates: Partial<Record<'branch_id' | 'expense_type_id' | 'category' | 'date_from' | 'date_to', string | null>>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}

export function ExpenseFilterBar({ filters, onChange, onClear, hasActiveFilters }: ExpenseFilterBarProps) {
  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];
  const types = useExpenseTypes({ branchId: filters.branchId === ALL_BRANCHES ? undefined : filters.branchId, includeInactive: true });

  // Types are told apart by id. Across branches a name can repeat, so the option says where each one is.
  const repeatedNames = new Set(
    (types.data ?? []).map((type) => type.name.toLowerCase()).filter((name, index, names) => names.indexOf(name) !== index),
  );
  function typeOptionLabel(type: NonNullable<typeof types.data>[number]): string {
    const where = repeatedNames.has(type.name.toLowerCase()) ? ` (${type.branches.map((branch) => branch.branch_name).join(', ')})` : '';
    return `${type.name}${where}${type.is_active ? '' : ' — deactivated'}`;
  }

  function handleTypeChange(value: string) {
    onChange({
      expense_type_id: value.startsWith('type:') ? value.slice('type:'.length) : null,
      category: value.startsWith('legacy:') ? value.slice('legacy:'.length) : null,
    });
  }

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
        <Label htmlFor="expense-type-filter">Type</Label>
        <Select value={filters.typeFilter} onValueChange={handleTypeChange}>
          <SelectTrigger id="expense-type-filter" className="w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TYPES}>All types</SelectItem>
            {(types.data ?? []).map((type) => (
              <SelectItem key={type.id} value={`type:${type.id}`}>
                {typeOptionLabel(type)}
              </SelectItem>
            ))}
            {Object.keys(EXPENSE_CATEGORY_LABELS).map((category) => (
              <SelectItem key={category} value={`legacy:${category}`}>
                {legacyExpenseCategoryLabel(category)}
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
