'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { BranchResponse, BranchStatus } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useChangeBranchStatus } from '@/hooks/queries/use-branches';

interface ChangeStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchResponse;
}

const STATUS_OPTIONS: { value: BranchStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'closed', label: 'Closed' },
];

export function ChangeStatusDialog({ open, onOpenChange, branch }: ChangeStatusDialogProps) {
  const [selected, setSelected] = useState<BranchStatus>(branch.status);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const changeStatus = useChangeBranchStatus(branch.id);

  function handleOpenChange(next: boolean) {
    if (next) setSelected(branch.status);
    onOpenChange(next);
  }

  async function commitChange() {
    await changeStatus.mutateAsync({ status: selected });
    onOpenChange(false);
  }

  function handleSave() {
    if (selected === branch.status) {
      onOpenChange(false);
      return;
    }
    if (selected === 'closed') {
      setConfirmingClose(true);
      return;
    }
    void commitChange();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change Branch Status</DialogTitle>
            <DialogDescription>Current status: {branch.currentStatusLabel}</DialogDescription>
          </DialogHeader>

          <RadioGroup value={selected} onValueChange={(value) => setSelected(value as BranchStatus)} className="gap-3">
            {STATUS_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-center gap-2">
                <RadioGroupItem value={option.value} id={`status-${option.value}`} />
                <Label htmlFor={`status-${option.value}`} className="font-normal">
                  {option.label}
                </Label>
              </div>
            ))}
          </RadioGroup>

          {selected === 'closed' && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>This will prevent any new shifts at this branch.</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={changeStatus.isPending}>
              {changeStatus.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmingClose}
        onOpenChange={setConfirmingClose}
        title="Close this branch?"
        description="This will prevent any new shifts at this branch. This action can be reversed later by changing the status again."
        variant="danger"
        confirmLabel="Close Branch"
        onConfirm={commitChange}
      />
    </>
  );
}
