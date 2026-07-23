'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useAuthStore } from '@/stores/auth.store';
import { useBranches } from '@/hooks/queries/use-branches';
import { useUpdateEmployee } from '@/hooks/queries/use-employees';

interface AssignmentManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

// Module-level constant so the Zustand selector below returns a stable
// reference when branchIds is undefined — inlining `?? []` would create a
// new array every render, which useSyncExternalStore treats as a changed
// snapshot and loops forever ("Maximum update depth exceeded").
const EMPTY_BRANCH_IDS: string[] = [];

/** Branch choices are scoped to the supervisor's own assigned branches — the backend rejects any branch_ids outside that set for supervisor callers (employees.service.ts's createEmployee/updateEmployee). */
export function SupervisorAssignmentManagerDialog({ open, onOpenChange, employee }: AssignmentManagerDialogProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const supervisorBranchIds = useAuthStore((state) => state.user?.branchIds ?? EMPTY_BRANCH_IDS);
  const { data: branchData, isLoading } = useBranches({ status: 'active', limit: 100 });
  const branches = (branchData?.branches ?? []).filter((branch) => supervisorBranchIds.includes(branch.id));
  const updateEmployee = useUpdateEmployee(employee.id);

  useEffect(() => {
    if (open) setSelected(employee.branch_assignments.map((assignment) => assignment.branch_id));
  }, [open, employee.branch_assignments]);

  function toggle(branchId: string, checked: boolean) {
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
          <DialogTitle>Manage Branch Assignments</DialogTitle>
          <DialogDescription>
            {employee.first_name} {employee.last_name} — select which of your branches this employee should access.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
            {branches.map((branch) => (
              <label key={branch.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.includes(branch.id)}
                  onCheckedChange={(checked) => toggle(branch.id, checked === true)}
                />
                <span className="font-medium">{branch.name}</span>
                <span className="text-xs text-muted-foreground">{branch.code}</span>
              </label>
            ))}
          </div>
        )}
        {selected.length === 0 && <p className="text-sm text-destructive">Select at least one branch.</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={selected.length === 0 || updateEmployee.isPending}>
            {updateEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
