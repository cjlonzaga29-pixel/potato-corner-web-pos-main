'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { EMPLOYEE_STATUS, EMPLOYEE_STATUS_LABELS, type EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  EmployeeApiError,
  useDeleteEmployee,
  useEmployeeDeletionEligibility,
  useSetEmployeeStatus,
  type EmployeeHistoryCategory,
} from '@/hooks/queries/use-employees';

const MIN_REASON_LENGTH = 10;

const HISTORY_LABELS: Record<EmployeeHistoryCategory, [string, string]> = {
  sales: ['sale or checkout', 'sales or checkouts'],
  shifts: ['shift', 'shifts'],
  attendance: ['attendance record', 'attendance records'],
  audit: ['audit-log entry', 'audit-log entries'],
  inventory: ['inventory record', 'inventory records'],
  expenses: ['expense', 'expenses'],
  catalog: ['product/catalog record', 'product/catalog records'],
  settings: ['settings change', 'settings changes'],
  pin_use: ['PIN verification', 'PIN verifications'],
};

function describeHistory(references: Record<EmployeeHistoryCategory, number>): string[] {
  return (Object.keys(HISTORY_LABELS) as EmployeeHistoryCategory[])
    .filter((key) => references[key] > 0)
    .map((key) => `${references[key]} ${references[key] === 1 ? HISTORY_LABELS[key][0] : HISTORY_LABELS[key][1]}`);
}

interface RemoveEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
  /** Called after a permanent delete (e.g. a detail page navigates back to its list). */
  onDeleted?: () => void;
}

/**
 * POS-PERF-P47 — the one Delete entry point for staff (Supervisor console)
 * and supervisors (Super Admin). Asks the server first whether the person
 * has any history:
 * - none → permanent delete, behind an explicit "cannot be undone" check;
 * - any → permanent delete is not offered; the same dialog offers
 *   Deactivate (status Inactive) instead, which ends access immediately
 *   and keeps every sale, attendance record and audit entry attributed.
 * The server enforces the same rules (and role/branch/self limits) on its
 * own; this dialog only explains them. No nested dialogs.
 */
export function RemoveEmployeeDialog({ open, onOpenChange, employee, onDeleted }: RemoveEmployeeDialogProps) {
  const eligibility = useEmployeeDeletionEligibility(employee.id, open);
  const deleteEmployee = useDeleteEmployee(employee.id);
  const setStatus = useSetEmployeeStatus(employee.id);

  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const [acknowledgeShift, setAcknowledgeShift] = useState(false);
  const [needsShiftAck, setNeedsShiftAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setConfirmed(false);
      setReason('');
      setAcknowledgeShift(false);
      setNeedsShiftAck(false);
      setError(null);
    }
  }, [open]);

  const name = `${employee.first_name} ${employee.last_name}`;
  const isActive = employee.status === EMPLOYEE_STATUS.ACTIVE;
  const data = eligibility.data;
  const history = data ? describeHistory(data.references) : [];
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;

  async function handleDelete() {
    setError(null);
    try {
      await deleteEmployee.mutateAsync();
      onOpenChange(false);
      onDeleted?.();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete');
      // A sale or clock-in may have landed since the dialog opened — re-check.
      if (deleteError instanceof EmployeeApiError && deleteError.code === 'EMPLOYEE_HAS_HISTORY') void eligibility.refetch();
    }
  }

  async function handleDeactivate() {
    setError(null);
    try {
      await setStatus.mutateAsync({ status: EMPLOYEE_STATUS.INACTIVE, reason: reason.trim(), acknowledge_active_shift: acknowledgeShift });
      onOpenChange(false);
    } catch (statusError) {
      if (statusError instanceof EmployeeApiError && statusError.code === 'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED') {
        setNeedsShiftAck(true);
        return;
      }
      setError(statusError instanceof Error ? statusError.message : 'Failed to deactivate');
    }
  }

  let body: ReactNode;
  let footer: ReactNode;

  if (eligibility.isLoading) {
    body = (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking history…
      </div>
    );
    footer = (
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
    );
  } else if (eligibility.isError || !data) {
    body = (
      <p className="text-sm text-destructive" role="alert">
        {eligibility.error instanceof Error ? eligibility.error.message : 'Could not check this person’s history.'}
      </p>
    );
    footer = (
      <>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button type="button" onClick={() => void eligibility.refetch()}>
          Try again
        </Button>
      </>
    );
  } else if (data.can_delete) {
    body = (
      <div className="space-y-3 text-sm">
        <p>
          <span className="font-medium">{name}</span> has no sales, shifts, attendance, inventory or audit history, so the account can be
          deleted permanently. Their PIN and branch assignment are removed with it.
        </p>
        <label className="flex items-start gap-2">
          <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} className="mt-0.5" />
          <span>I understand this permanently deletes the account and cannot be undone.</span>
        </label>
      </div>
    );
    footer = (
      <>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" variant="danger" disabled={!confirmed || deleteEmployee.isPending} onClick={() => void handleDelete()}>
          {deleteEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Delete permanently
        </Button>
      </>
    );
  } else {
    body = (
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="font-medium">This person can’t be permanently deleted.</p>
          {data.blocked_reason === 'branch_account' ? (
            <p className="text-muted-foreground">Branch accounts follow their branch and are never deleted here.</p>
          ) : (
            <p className="text-muted-foreground">
              Their name is on {history.join(', ')}. Deleting them would break that history, so it is kept.
            </p>
          )}
        </div>
        {isActive ? (
          <>
            <p>
              <span className="font-medium">Deactivate instead:</span> sets the status to Inactive, signs them out, removes their branch
              access and PIN use, and keeps every past record attributed to {name}.
            </p>
            <div className="space-y-2">
              <Label htmlFor="remove-employee-reason">
                Reason<span className="ml-0.5 text-destructive">*</span>
              </Label>
              <Textarea
                id="remove-employee-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={`Minimum ${MIN_REASON_LENGTH} characters`}
                rows={3}
                aria-invalid={reason.length > 0 && !reasonValid}
                aria-describedby="remove-employee-reason-hint"
              />
              <p id="remove-employee-reason-hint" className="text-xs text-muted-foreground">
                Recorded in the audit log.
              </p>
            </div>
            {needsShiftAck && (
              <div className="space-y-2 rounded-md bg-destructive/10 p-3 text-destructive" role="alert">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>This person has an active shift. Deactivating does not close it automatically.</span>
                </div>
                <label className="flex items-center gap-2 text-foreground">
                  <Checkbox checked={acknowledgeShift} onCheckedChange={(checked) => setAcknowledgeShift(checked === true)} />
                  Deactivate anyway
                </label>
              </div>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            Already {EMPLOYEE_STATUS_LABELS[employee.status].toLowerCase()} — they have no access, and their history stays attributed to them.
          </p>
        )}
      </div>
    );
    footer = isActive ? (
      <>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={!reasonValid || (needsShiftAck && !acknowledgeShift) || setStatus.isPending}
          onClick={() => void handleDeactivate()}
        >
          {setStatus.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Deactivate (keep history)
        </Button>
      </>
    ) : (
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {name}</DialogTitle>
          <DialogDescription>Permanent deletion is only possible for accounts with no history.</DialogDescription>
        </DialogHeader>
        {body}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
