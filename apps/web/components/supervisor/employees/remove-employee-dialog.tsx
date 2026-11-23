'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  EmployeeApiError,
  forgetDeletedEmployee,
  useDeleteEmployee,
  useEmployeeDeletionEligibility,
  type EmployeeHistoryCategory,
} from '@/hooks/queries/use-employees';

const HISTORY_LABELS: Record<EmployeeHistoryCategory, [string, string]> = {
  sales: ['sale or checkout', 'sales or checkouts'],
  shifts: ['shift', 'shifts'],
  attendance: ['attendance record', 'attendance records'],
  audit: ['audit-log entry', 'audit-log entries'],
  inventory: ['inventory or supply record', 'inventory or supply records'],
  expenses: ['expense record', 'expense records'],
  catalog: ['product/catalog record', 'product/catalog records'],
  settings: ['settings change', 'settings changes'],
  pin_use: ['PIN verification', 'PIN verifications'],
  payroll: ['payroll record', 'payroll records'],
};

function describeHistory(references: Partial<Record<EmployeeHistoryCategory, number>>): string[] {
  return (Object.keys(HISTORY_LABELS) as EmployeeHistoryCategory[])
    .filter((key) => (references[key] ?? 0) > 0)
    .map((key) => {
      const count = references[key] ?? 0;
      return `${count} ${count === 1 ? HISTORY_LABELS[key][0] : HISTORY_LABELS[key][1]}`;
    });
}

/** Same rule as the server: case and extra spaces don't matter. */
function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-PH');
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

interface RemoveEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeResponse;
  /** Called after the account is deleted (e.g. a detail page navigates back to its list). */
  onDeleted?: () => void;
}

/**
 * POS-PERF-P66 — the one Delete entry point for staff (Supervisor console)
 * and supervisors (Super Admin). Delete permanently removes the account:
 * login, password, sessions, PIN and branch access. Past business records
 * stay, still under the person's name. The server enforces every rule
 * (role, branch, self, open work, unpaid payroll hours) and re-checks the
 * typed name and the account version shown here; this dialog explains them.
 */
export function RemoveEmployeeDialog({ open, onOpenChange, employee, onDeleted }: RemoveEmployeeDialogProps) {
  const queryClient = useQueryClient();
  const eligibility = useEmployeeDeletionEligibility(employee.id, open);
  const deleteEmployee = useDeleteEmployee(employee.id);

  const [typedName, setTypedName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards the gap between the click and isPending becoming true (double click).
  const submitting = useRef(false);

  useEffect(() => {
    if (open) {
      setTypedName('');
      setAcknowledged(false);
      setError(null);
    }
  }, [open]);

  const fallbackName = `${employee.first_name} ${employee.last_name}`;
  const data = eligibility.data;
  const name = data?.confirmation?.name ?? fallbackName;
  const history = data?.references ? describeHistory(data.references) : [];
  const prerequisites = data?.prerequisites ?? null;
  const nameMatches = normalizeName(typedName) === normalizeName(name);

  function finishDeleted(message: string) {
    forgetDeletedEmployee(queryClient, employee.id);
    toast.success(message);
    onOpenChange(false);
    onDeleted?.();
  }

  async function handleDelete() {
    if (submitting.current || !data?.confirmation) return;
    submitting.current = true;
    setError(null);
    try {
      await deleteEmployee.mutateAsync({ confirm_name: typedName, version: data.confirmation.version });
      onOpenChange(false);
      onDeleted?.();
    } catch (deleteError) {
      // The request may have gone through even though no answer came back
      // (lost connection, timeout). Ask the server before showing an error.
      const recheck = await eligibility.refetch();
      if (recheck.data?.blocked_reason === 'already_deleted') {
        finishDeleted('Account permanently deleted');
        return;
      }
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete');
      if (deleteError instanceof EmployeeApiError && deleteError.code === 'EMPLOYEE_CHANGED') setTypedName('');
    } finally {
      submitting.current = false;
    }
  }

  let body: ReactNode;
  let footer: ReactNode;
  const closeButton = (label: string) => (
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
      {label}
    </Button>
  );

  if (eligibility.isLoading) {
    body = (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking this account…
      </div>
    );
    footer = closeButton('Cancel');
  } else if (eligibility.isError || !data) {
    body = (
      <p className="text-sm text-destructive" role="alert">
        {eligibility.error instanceof Error ? eligibility.error.message : 'Could not check this account.'}
      </p>
    );
    footer = (
      <>
        {closeButton('Close')}
        <Button type="button" onClick={() => void eligibility.refetch()}>
          Try again
        </Button>
      </>
    );
  } else if (data.blocked_reason === 'already_deleted') {
    body = <p className="text-sm text-muted-foreground">{name}’s account has already been permanently deleted. Their past records remain.</p>;
    footer = closeButton('Close');
  } else if (data.blocked_reason === 'branch_account') {
    body = (
      <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
        Branch accounts follow their branch and can’t be deleted here.
      </p>
    );
    footer = closeButton('Close');
  } else if (data.blocked_reason === 'open_operations') {
    body = (
      <div className="space-y-3 text-sm" role="alert">
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="font-medium">{name} can’t be deleted yet. First:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {prerequisites?.open_shifts.map((shift) => (
              <li key={shift.id}>Close the open shift at {shift.branch_name} (count the cash).</li>
            ))}
            {prerequisites?.open_attendance.map((record) => (
              <li key={record.id}>Clock them out, or correct the attendance record, at {record.branch_name}.</li>
            ))}
            {prerequisites?.unpaid_payroll?.map((item) => (
              <li key={item.branch_id}>
                Finalize payroll at {item.branch_name} for the hours recorded{' '}
                {item.first_date === item.last_date
                  ? `on ${formatDay(item.first_date)}`
                  : `from ${formatDay(item.first_date)} to ${formatDay(item.last_date)}`}
                , so those hours are paid.
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground">Nothing has been changed. Check again once these are done.</p>
      </div>
    );
    footer = (
      <>
        {closeButton('Close')}
        <Button type="button" onClick={() => void eligibility.refetch()}>
          Check again
        </Button>
      </>
    );
  } else if (!data.can_delete || !data.confirmation || data.mode !== 'permanent') {
    // A pre-P66 server: it cannot confirm a permanent delete, so none is offered.
    body = (
      <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="alert">
        The server can’t confirm a permanent delete right now. Reload the page and try again later. Nothing has been changed.
      </p>
    );
    footer = closeButton('Close');
  } else {
    const uncovered = prerequisites?.branches_left_without_supervisor ?? [];
    const branches = prerequisites?.branches ?? [];
    body = (
      <div className="space-y-3 text-sm">
        <p className="font-medium">
          Permanently delete {name}? This cannot be undone in the application. Past business records will remain, but this account cannot be
          restored.
        </p>
        <div>
          <p className="font-medium">Removed now</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>The account, its login and password: {name} is signed out on every device.</li>
            <li>PIN access and notifications.</li>
            <li>Branch access{branches.length > 0 ? ` (${branches.map((b) => b.name).join(', ')})` : ''}.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Stays</p>
          <p className="mt-1 text-muted-foreground">
            {history.length > 0
              ? `${history.join(', ')}. These keep showing ${name} as the person who did them.`
              : `No past records name ${name}.`}{' '}
            Sales totals, expenses, attendance, payroll and stock records are not changed.
          </p>
        </div>
        {employee.email && (
          <p className="text-muted-foreground">
            The email {employee.email} is released and can be used for a new account. A new account starts fresh: it gets a new ID and none of
            this account’s past records, PIN, sessions or access.
          </p>
        )}
        {uncovered.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3" role="status">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{uncovered.map((b) => b.name).join(', ')} will have no assigned supervisor. You can assign one from Branches afterwards.</span>
          </div>
        )}
        {prerequisites && (prerequisites.held_orders > 0 || prerequisites.pending_inventory_approvals > 0) && (
          <p className="text-muted-foreground">
            {[
              prerequisites.held_orders > 0 ? `${prerequisites.held_orders} held order(s)` : null,
              prerequisites.pending_inventory_approvals > 0 ? `${prerequisites.pending_inventory_approvals} pending inventory approval(s)` : null,
            ]
              .filter(Boolean)
              .join(' and ')}{' '}
            stay on their branch under {name}’s name and can still be handled there.
          </p>
        )}
        <p className="text-muted-foreground">
          To stop access for now without deleting, change their status to Inactive instead. That can be undone, and the account keeps its email.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="delete-employee-confirm-name">
            Type <span className="font-semibold">{name}</span> to confirm
          </Label>
          <Input
            id="delete-employee-confirm-name"
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={typedName.length > 0 && !nameMatches}
          />
        </div>
        <label className="flex items-start gap-2">
          <Checkbox checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} className="mt-0.5" />
          <span>I understand {name}’s account is deleted permanently and cannot be restored.</span>
        </label>
      </div>
    );
    footer = (
      <>
        {closeButton('Cancel')}
        <Button
          type="button"
          variant="danger"
          disabled={!nameMatches || !acknowledged || deleteEmployee.isPending}
          onClick={() => void handleDelete()}
        >
          {deleteEmployee.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Delete permanently
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && deleteEmployee.isPending ? undefined : onOpenChange(next))}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>Delete {name}</DialogTitle>
          <DialogDescription>Deletes the account permanently. Past records keep their name.</DialogDescription>
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
