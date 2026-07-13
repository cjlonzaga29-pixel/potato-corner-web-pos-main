'use client';

import { useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { Loader2 } from 'lucide-react';
import type { EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { generateInitials } from '@/lib/utils';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useAssignSupervisor } from '@/hooks/queries/use-branches';

interface AssignSupervisorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string;
}

export function AssignSupervisorDialog({ open, onOpenChange, branchId }: AssignSupervisorDialogProps) {
  const [search, setSearch] = useState('');
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const { data, isLoading } = useEmployees({ role: 'supervisor', limit: 100 });
  const assignSupervisor = useAssignSupervisor(branchId);

  const supervisors = useMemo(() => data?.employees ?? [], [data]);
  const fuse = useMemo(
    () => new Fuse(supervisors, { keys: ['first_name', 'last_name', 'email'], threshold: 0.35 }),
    [supervisors],
  );

  const results: EmployeeResponse[] = search.trim()
    ? fuse.search(search).map((result) => result.item)
    : supervisors;

  async function handleAssign(userId: string) {
    setAssigningId(userId);
    try {
      await assignSupervisor.mutateAsync({ userId });
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Supervisor</DialogTitle>
          <DialogDescription>Search by name or email to find a supervisor to assign to this branch.</DialogDescription>
        </DialogHeader>

        <SearchInput value={search} onChange={setSearch} placeholder="Search supervisors..." />

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : results.length === 0 ? (
            <EmptyState title="No supervisors found" description="Try a different search term." />
          ) : (
            results.map((supervisor) => {
              const alreadyAssigned = supervisor.branch_assignments.some((assignment) => assignment.branch_id === branchId);
              return (
                <div key={supervisor.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                      {generateInitials(supervisor.first_name, supervisor.last_name)}
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {supervisor.first_name} {supervisor.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground">{supervisor.email}</p>
                      {supervisor.branch_assignments.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {supervisor.branch_assignments.length} active branch{supervisor.branch_assignments.length === 1 ? '' : 'es'}
                        </p>
                      )}
                    </div>
                  </div>
                  {alreadyAssigned ? (
                    <Badge variant="active">Assigned</Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleAssign(supervisor.id)}
                      disabled={assigningId === supervisor.id}
                    >
                      {assigningId === supervisor.id && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                      Select
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
