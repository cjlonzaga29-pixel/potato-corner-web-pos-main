'use client';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';

interface AdminBranchSelectProps {
  branchId: string | null;
  onBranchChange: (id: string | null) => void;
}

/**
 * Admin has no single "active branch" the way Supervisor/Branch chrome does
 * (useBranchStore), so the Admin Inventory Movements/Cost Corrections
 * screens need their own explicit branch picker — this is that picker,
 * shared by both so they stay in sync in look/behavior. The underlying
 * movements/cost-corrections endpoints are branch-scoped (one branchId per
 * request, per branchGuard), not a cross-branch aggregate, so "All Branches"
 * isn't offered here the way report filters do it.
 */
export function AdminBranchSelect({ branchId, onBranchChange }: AdminBranchSelectProps) {
  const { data: branchesData } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="w-full sm:w-auto">
      <Label htmlFor="admin-inventory-branch">Branch</Label>
      <Select value={branchId ?? undefined} onValueChange={onBranchChange}>
        <SelectTrigger id="admin-inventory-branch" className="w-full sm:w-[220px]">
          <SelectValue placeholder="Select a branch" />
        </SelectTrigger>
        <SelectContent>
          {branches.map((branch) => (
            <SelectItem key={branch.id} value={branch.id}>
              {branch.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
