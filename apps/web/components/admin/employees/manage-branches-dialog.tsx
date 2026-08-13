'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useBranches } from '@/hooks/queries/use-branches';
import { useUpdateEmployee } from '@/hooks/queries/use-employees';

interface ManageBranchesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

/**
 * Admin-only branch reassignment. Calls PATCH /api/employees/:id with just
 * branch_ids — employees.service.ts's updateEmployee replaces the
 * assignment set (employees.repository.ts's updateBranchAssignments), so
 * access to a removed branch is revoked immediately, not just hidden in the
 * UI. Doesn't delete/recreate the account.
 */
export function ManageBranchesDialog({ open, onOpenChange, employee }: ManageBranchesDialogProps) {
  const updateEmployee = useUpdateEmployee(employee.id);
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const branches = branchData?.branches ?? [];
  const isSingleBranch = employee.role === 'staff';

  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (open) setSelected(employee.branch_assignments.map((assignment) => assignment.branch_id));
  }, [open, employee.branch_assignments]);

  function toggleBranch(branchId: string, checked: boolean) {
    if (isSingleBranch) {
      setSelected(checked ? [branchId] : []);
      return;
    }
    setSelected((prev) => (checked ? [...prev, branchId] : prev.filter((id) => id !== branchId)));
  }

  async function handleSave() {
    if (selected.length === 0) return;
    await updateEmployee.mutateAsync({ branch_ids: selected });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Branches</DialogTitle>
          <DialogDescription>
            {isSingleBranch
              ? `Change which branch ${employee.first_name} ${employee.last_name} belongs to.`
              : `Change which branches ${employee.first_name} ${employee.last_name} can access.`}
          </DialogDescription>
        </DialogHeader>

        {branchesLoading ? (
          <p className="text-sm text-muted-foreground">Loading branches...</p>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
            {branches.map((branch) => (
              <label key={branch.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.includes(branch.id)}
                  onCheckedChange={(checked) => toggleBranch(branch.id, checked === true)}
                />
                {branch.name} ({branch.code})
              </label>
            ))}
          </div>
        )}
        {selected.length === 0 && (
          <p className="text-xs text-destructive">At least one branch must remain assigned.</p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={selected.length === 0 || updateEmployee.isPending} onClick={() => void handleSave()}>
            {updateEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
