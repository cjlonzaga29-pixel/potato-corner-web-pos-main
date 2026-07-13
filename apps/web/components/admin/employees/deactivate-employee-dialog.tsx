'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_LABELS, type EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useDeactivateEmployee, EmployeeApiError } from '@/hooks/queries/use-employees';

const MIN_REASON_LENGTH = 10;

interface DeactivateEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

export function DeactivateEmployeeDialog({ open, onOpenChange, employee }: DeactivateEmployeeDialogProps) {
  const [reason, setReason] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [showActiveShiftWarning, setShowActiveShiftWarning] = useState(false);
  const deactivateEmployee = useDeactivateEmployee(employee.id);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setReason('');
      setAcknowledge(false);
      setShowActiveShiftWarning(false);
    }
    onOpenChange(next);
  }

  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  const canSubmit = reasonValid && (!showActiveShiftWarning || acknowledge);

  async function handleSubmit() {
    try {
      await deactivateEmployee.mutateAsync({ reason, acknowledge_active_shift: acknowledge });
      handleOpenChange(false);
    } catch (error) {
      if (error instanceof EmployeeApiError && error.code === 'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED') {
        setShowActiveShiftWarning(true);
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Failed to deactivate employee');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deactivate Employee</DialogTitle>
          <DialogDescription>
            {employee.first_name} {employee.last_name} — {ROLE_LABELS[employee.role]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="deactivate-reason">
              Reason<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Textarea
              id="deactivate-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Minimum 10 characters"
              rows={3}
            />
            {reason.length > 0 && !reasonValid && (
              <p className="text-sm text-destructive">Reason must be at least {MIN_REASON_LENGTH} characters.</p>
            )}
          </div>

          {showActiveShiftWarning && (
            <div className="space-y-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>This employee has an active shift. Deactivating will not automatically close their shift.</span>
              </div>
              <label className="flex items-center gap-2 font-normal text-foreground">
                <Checkbox checked={acknowledge} onCheckedChange={(checked) => setAcknowledge(checked === true)} />
                I understand and want to proceed anyway
              </label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!canSubmit || deactivateEmployee.isPending}
            onClick={() => void handleSubmit()}
          >
            {deactivateEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
