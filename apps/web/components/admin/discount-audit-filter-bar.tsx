'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';

const ALL_BRANCHES = 'all';
const ALL_DISCOUNT_TYPES = 'all';

const DISCOUNT_TYPE_OPTIONS = [
  { value: 'pwd', label: 'PWD' },
  { value: 'senior_citizen', label: 'Senior Citizen' },
  { value: 'employee', label: 'Employee' },
  { value: 'manager_override', label: 'Manager Override' },
  { value: 'promotional', label: 'Promotional' },
];

export interface DiscountAuditFilterValues {
  branchId: string;
  discountType: string;
  dateFrom: string;
  dateTo: string;
}

export interface DiscountAuditFilterBarProps {
  filters: DiscountAuditFilterValues;
  onChange: (updates: Partial<Record<'branch_id' | 'discount_type' | 'date_from' | 'date_to', string | null>>) => void;
}

export function DiscountAuditFilterBar({ filters, onChange }: DiscountAuditFilterBarProps) {
  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <Label htmlFor="discount-audit-branch-filter">Branch</Label>
        <Select value={filters.branchId} onValueChange={(value) => onChange({ branch_id: value })}>
          <SelectTrigger id="discount-audit-branch-filter" className="w-[220px]" disabled={isBranchesLoading}>
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
        <Label htmlFor="discount-audit-type-filter">Discount Type</Label>
        <Select value={filters.discountType} onValueChange={(value) => onChange({ discount_type: value })}>
          <SelectTrigger id="discount-audit-type-filter" className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_DISCOUNT_TYPES}>All types</SelectItem>
            {DISCOUNT_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="discount-audit-date-from-filter">Date From</Label>
        <Input
          id="discount-audit-date-from-filter"
          type="date"
          className="w-[170px]"
          value={filters.dateFrom}
          onChange={(e) => onChange({ date_from: e.target.value || null })}
        />
      </div>

      <div>
        <Label htmlFor="discount-audit-date-to-filter">Date To</Label>
        <Input
          id="discount-audit-date-to-filter"
          type="date"
          className="w-[170px]"
          value={filters.dateTo}
          onChange={(e) => onChange({ date_to: e.target.value || null })}
        />
      </div>
    </div>
  );
}
