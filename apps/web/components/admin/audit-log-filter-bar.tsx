'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';

const ALL_BRANCHES = 'all';

export interface AuditLogFilterValues {
  branchId: string;
  dateFrom: string;
  dateTo: string;
  action: string;
  entityType: string;
}

export interface AuditLogFilterBarProps {
  filters: AuditLogFilterValues;
  onChange: (updates: Partial<Record<'branch_id' | 'date_from' | 'date_to' | 'action' | 'entity_type', string | null>>) => void;
}

export function AuditLogFilterBar({ filters, onChange }: AuditLogFilterBarProps) {
  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <Label htmlFor="audit-branch-filter">Branch</Label>
        <Select value={filters.branchId} onValueChange={(value) => onChange({ branch_id: value })}>
          <SelectTrigger id="audit-branch-filter" className="w-[220px]" disabled={isBranchesLoading}>
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
        <Label htmlFor="audit-date-from-filter">Date From</Label>
        <Input
          id="audit-date-from-filter"
          type="date"
          className="w-[170px]"
          value={filters.dateFrom}
          onChange={(e) => onChange({ date_from: e.target.value || null })}
        />
      </div>

      <div>
        <Label htmlFor="audit-date-to-filter">Date To</Label>
        <Input
          id="audit-date-to-filter"
          type="date"
          className="w-[170px]"
          value={filters.dateTo}
          onChange={(e) => onChange({ date_to: e.target.value || null })}
        />
      </div>

      <div>
        <Label htmlFor="audit-action-filter">Action</Label>
        <Input
          id="audit-action-filter"
          type="text"
          className="w-[180px]"
          placeholder="e.g. update"
          value={filters.action}
          onChange={(e) => onChange({ action: e.target.value || null })}
        />
      </div>

      <div>
        <Label htmlFor="audit-entity-type-filter">Entity Type</Label>
        <Input
          id="audit-entity-type-filter"
          type="text"
          className="w-[180px]"
          placeholder="e.g. product"
          value={filters.entityType}
          onChange={(e) => onChange({ entity_type: e.target.value || null })}
        />
      </div>
    </div>
  );
}
