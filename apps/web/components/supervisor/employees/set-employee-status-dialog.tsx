'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { EMPLOYEE_STATUS, EMPLOYEE_STATUS_LABELS, type EmployeeResponse, type EmployeeStatus } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSetEmployeeStatus, EmployeeApiError } from '@/hooks/queries/use-employees';

const MIN_REASON_LENGTH = 10;
const STATUS_VALUES = Object.values(EMPLOYEE_STATUS) as EmployeeStatus[];

interface SetEmployeeStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
}

/**
 * CR-003 (Branch Operating System) full 5-state lifecycle transition —
 * replaces a plain active/inactive toggle. Moving away from ACTIVE
 * immediately revokes the employee's sessions and blocks POS/attendance/
 * inventory/reports access (enforced server-side); history is never
 * deleted.
 */
export function SetEmployeeStatusDialog({ open, onOpenChange, employee }: SetEmployeeStatusDialogProps) {
  const [status, setStatus] = useState<EmployeeStatus>(employee.status);
  const [reason, setReason] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [showActiveShiftWarning, setShowActiveShiftWarning] = useState(false);
  const setEmployeeStatus = useSetEmployeeStatus(employee.id);

  useEffect(() => {
    if (open) {
      setStatus(employee.status);
      setReason('');
      setAcknowledge(false);
      setShowActiveShiftWarning(false);
    }
  }, [open, employee.status]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  const isActive = status === EMPLOYEE_STATUS.ACTIVE;
  const reasonValid = isActive || reason.trim().length >= MIN_REASON_LENGTH;
  const unchanged = status === employee.status;
  const canSubmit = reasonValid && !unchanged && (!showActiveShiftWarning || acknowledge);

  async function handleSubmit() {
    try {
      await setEmployeeStatus.mutateAsync({
        status,
        reason: isActive ? undefined : reason,
        acknowledge_active_shift: acknowledge,
      });
      handleOpenChange(false);
    } catch (error) {
      if (error instanceof EmployeeApiError && error.code === 'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED') {
        setShowActiveShiftWarning(true);
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Failed to change employee status');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Employee Status</DialogTitle>
          <DialogDescription>
            {employee.first_name} {employee.last_name} — currently {EMPLOYEE_STATUS_LABELS[employee.status]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as EmployeeStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {EMPLOYEE_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isActive && (
            <div className="space-y-2">
              <Label htmlFor="status-reason">
                Reason<span className="ml-0.5 text-destructive">*</span>
              </Label>
              <Textarea
                id="status-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Minimum 10 characters"
                rows={3}
              />
              {reason.length > 0 && !reasonValid && (
                <p className="text-sm text-destructive">Reason must be at least {MIN_REASON_LENGTH} characters.</p>
              )}
            </div>
          )}

          {!isActive && (
            <p className="text-xs text-muted-foreground">
              This immediately revokes active sessions and blocks POS, Attendance, Inventory, and Reports access. Historical
              attendance, transactions, and audit logs are preserved.
            </p>
          )}

          {showActiveShiftWarning && (
            <div className="space-y-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>This employee has an active shift. Changing status will not automatically close their shift.</span>
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
            variant={isActive ? 'default' : 'danger'}
            disabled={!canSubmit || setEmployeeStatus.isPending}
            onClick={() => void handleSubmit()}
          >
            {setEmployeeStatus.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
