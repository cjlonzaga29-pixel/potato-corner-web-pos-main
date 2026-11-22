'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BranchResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useBranchDeletionEligibility, useDeleteBranch } from '@/hooks/queries/use-branches';

interface DeleteBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchResponse;
}

const KEPT_LABELS: Record<string, [string, string]> = {
  sales: ['sale', 'sales'],
  shifts: ['shift', 'shifts'],
  attendance: ['attendance record', 'attendance records'],
  expenses: ['expense', 'expenses'],
  payroll_runs: ['payroll run', 'payroll runs'],
  pay_rates: ['pay rate', 'pay rates'],
  stock_movements: ['stock movement', 'stock movements'],
  legacy_inventory_movements: ['older inventory movement', 'older inventory movements'],
  cost_corrections: ['cost correction', 'cost corrections'],
  extra_supply_issues: ['Extra Supplies record', 'Extra Supplies records'],
  discount_proofs: ['discount proof', 'discount proofs'],
  discount_types: ['discount type', 'discount types'],
  audit_entries: ['audit-log entry', 'audit-log entries'],
  fraud_alerts: ['fraud alert', 'fraud alerts'],
};

function describeCounts(counts: Record<string, number> | null, labels: Record<string, [string, string]>): string[] {
  if (!counts) return [];
  return Object.keys(labels)
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => {
      const count = counts[key] ?? 0;
      const [one, many] = labels[key] ?? [key, key];
      return `${count} ${count === 1 ? one : many}`;
    });
}

/** Same rule as the server: case and extra spaces don't matter for the name; the code must match exactly. */
function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-PH');
}

/**
 * POS-PERF-P67 — permanent delete of the operational branch. The branch, its
 * login account, everyone's access to it and its settings go; every past
 * business record stays, under the branch's name and code. The server checks
 * open work, the typed name and code, the branch version and a confirmation
 * issued to this Super Admin; this dialog explains them. Cancel sends nothing.
 */
export function DeleteBranchDialog({ open, onOpenChange, branch }: DeleteBranchDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const eligibility = useBranchDeletionEligibility(branch.id, open);
  const deleteBranch = useDeleteBranch(branch.id);

  const [typedName, setTypedName] = useState('');
  const [typedCode, setTypedCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards the gap between the click and isPending becoming true (double click).
  const submitting = useRef(false);

  useEffect(() => {
    if (open) {
      setTypedName('');
      setTypedCode('');
      setAcknowledged(false);
      setError(null);
    }
  }, [open]);

  const data = eligibility.data;
  const name = data?.confirmation?.name ?? branch.name;
  const code = data?.confirmation?.code ?? branch.code;
  const kept = describeCounts(data?.history_retained ?? null, KEPT_LABELS);
  const removed = data?.removed ?? null;
  const matches = normalizeName(typedName) === normalizeName(name) && typedCode.trim() === code;

  function finishDeleted(message: string) {
    void queryClient.invalidateQueries({ queryKey: ['branches'] });
    queryClient.removeQueries({ queryKey: ['branch', branch.id] });
    toast.success(message);
    onOpenChange(false);
    router.push('/admin/branches');
  }

  async function handleDelete() {
    if (submitting.current || !data?.confirmation) return;
    submitting.current = true;
    setError(null);
    try {
      await deleteBranch.mutateAsync({
        confirm_name: typedName,
        confirm_code: typedCode,
        version: data.confirmation.version,
        confirmation_token: data.confirmation.confirmation_token,
      });
      onOpenChange(false);
      router.push('/admin/branches');
    } catch (deleteError) {
      // The request may have gone through although no answer came back (lost
      // connection, timeout). Ask the server before showing an error; this also
      // refreshes the version and confirmation after a concurrent change.
      const recheck = await eligibility.refetch();
      if (recheck.data?.blocked_reason === 'already_deleted') {
        finishDeleted('Branch deleted. Its history was kept.');
        return;
      }
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete branch');
    } finally {
      submitting.current = false;
    }
  }

  const closeButton = (label: string) => (
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
      {label}
    </Button>
  );
  let body: ReactNode;
  let footer: ReactNode;

  if (eligibility.isLoading) {
    body = (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking this branch…
      </div>
    );
    footer = closeButton('Cancel');
  } else if (eligibility.isError || !data) {
    body = (
      <p className="text-sm text-destructive" role="alert">
        {eligibility.error instanceof Error ? eligibility.error.message : 'Could not check this branch.'}
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
    body = <p className="text-sm text-muted-foreground">{name} has already been deleted. Its past records remain.</p>;
    footer = closeButton('Close');
  } else if (data.blocked_reason === 'open_operations') {
    body = (
      <div className="space-y-3 text-sm" role="alert">
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="font-medium">{name} can’t be deleted yet. First:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {data.blockers.map((blocker) => (
              <li key={blocker.code}>
                {blocker.message} ({blocker.count})
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground">Nothing has been changed. Check again once these are done, or close the branch instead.</p>
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
  } else if (!data.can_delete || !data.confirmation) {
    body = <p className="text-sm text-muted-foreground">This branch can’t be deleted right now.</p>;
    footer = closeButton('Close');
  } else {
    body = (
      <div className="space-y-4 text-sm">
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Deleting {name} ({code}) can’t be undone in the application. The branch can’t be restored, and its code can’t be used
            again.
          </span>
        </div>
        <div>
          <p className="font-medium">Removed now</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>The branch itself, its settings, product availability and promotion enrolment</li>
            <li>
              Its branch login account{(removed?.branch_accounts ?? 0) === 1 ? '' : 's'} ({removed?.branch_accounts ?? 0}), signed out at once
            </li>
            <li>Everyone’s access to this branch ({removed?.staff_and_supervisor_access ?? 0}); their own accounts stay</li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Kept, under this branch’s name and code</p>
          <p className="mt-1 text-muted-foreground">
            {kept.length > 0 ? `${kept.join(', ')}.` : 'All past business records.'} Reports, receipts and payroll history keep showing them.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="delete-branch-name">
            Type the branch name <span className="font-semibold">{name}</span>
          </Label>
          <Input id="delete-branch-name" autoComplete="off" value={typedName} onChange={(event) => setTypedName(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="delete-branch-code">
            Type the branch code <span className="font-mono font-semibold">{code}</span>
          </Label>
          <Input id="delete-branch-code" autoComplete="off" value={typedCode} onChange={(event) => setTypedCode(event.target.value)} />
        </div>
        <label className="flex items-start gap-2" htmlFor="delete-branch-ack">
          <Checkbox id="delete-branch-ack" checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} />
          <span>I understand the branch is deleted permanently and its past records stay.</span>
        </label>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    );
    footer = (
      <>
        {closeButton('Cancel')}
        <Button
          type="button"
          variant="danger"
          disabled={!matches || !acknowledged || deleteBranch.isPending}
          onClick={() => void handleDelete()}
        >
          {deleteBranch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Permanently delete branch
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Permanently delete {name}?</DialogTitle>
          <DialogDescription>
            The branch and its access are removed. Past sales, shifts, attendance, expenses, payroll and stock history remain.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
