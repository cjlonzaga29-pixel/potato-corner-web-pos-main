'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BranchResponse, ForceDeletionStatus } from '@potato-corner/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  abortForceDeletion,
  fetchForceDeletionStatus,
  startForceDeletion,
  useForceDeletionPlan,
} from '@/hooks/queries/use-branch-force-deletion';

interface ForceDeleteBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchResponse;
}

const POLL_MS = 2_000;

/** One operation id per confirmation, kept across a reload so a repeat finds the same operation. */
function storageKey(branchId: string): string {
  return `pos-p68-force-delete:${branchId}`;
}
function readStoredOperation(branchId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(branchId));
  } catch {
    return null;
  }
}
function storeOperation(branchId: string, operationId: string | null): void {
  try {
    if (operationId) window.sessionStorage.setItem(storageKey(branchId), operationId);
    else window.sessionStorage.removeItem(storageKey(branchId));
  } catch {
    // Storage unavailable: the operation is still durable on the server.
  }
}
function newOperationId(): string {
  return crypto.randomUUID();
}

function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-PH');
}

/**
 * POS-PERF-P68 — Force Delete Branch. For a branch that normal Delete
 * refuses because of open work. One confirmation; the server fences the
 * branch, gives every open item an explicit outcome (nothing counted,
 * clocked out, finalized or written off on anyone's behalf), records what is
 * left unresolved, then deletes the operational branch. Cancel sends nothing.
 */
export function ForceDeleteBranchDialog({
  open,
  onOpenChange,
  branch,
}: ForceDeleteBranchDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const plan = useForceDeletionPlan(branch.id, open);
  const [typedName, setTypedName] = useState('');
  const [typedCode, setTypedCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ForceDeletionStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const operationId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const finish = useCallback(
    (message: string) => {
      storeOperation(branch.id, null);
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      queryClient.removeQueries({ queryKey: ['branch', branch.id] });
      toast.success(message);
      onOpenChange(false);
      router.push('/admin/branches');
    },
    [branch.id, onOpenChange, queryClient, router],
  );

  const applyStatus = useCallback(
    (next: ForceDeletionStatus) => {
      setStatus(next);
      if (next.status === 'completed' || next.status === 'already_deleted') {
        finish(
          'Branch force-deleted. Its history was kept; unresolved items are listed under Deleted-branch items.',
        );
      } else if (next.status === 'aborted') {
        storeOperation(branch.id, null);
        operationId.current = newOperationId();
        setError(next.abort_reason ?? 'The Force Delete was stopped. Nothing was deleted.');
        void plan.refetch();
      }
    },
    [branch.id, finish, plan],
  );

  // On open: resume an operation this browser started (after a reload or a lost response).
  useEffect(() => {
    if (!open) return;
    setTypedName('');
    setTypedCode('');
    setAcknowledged(false);
    setError(null);
    setStatus(null);
    const stored = readStoredOperation(branch.id);
    operationId.current = stored ?? newOperationId();
    if (stored) {
      fetchForceDeletionStatus(stored)
        .then((found) => {
          if (found) applyStatus(found);
          else operationId.current = stored; // never started: reuse the id for this confirmation
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branch.id]);

  // While fenced, poll; each poll also lets the server finish the operation.
  useEffect(() => {
    if (!open || status?.status !== 'fenced' || !status.operation_id) return;
    const id = status.operation_id;
    const timer = setInterval(() => {
      fetchForceDeletionStatus(id)
        .then((found) => {
          if (found) applyStatus(found);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, status, applyStatus]);

  const data = plan.data;
  const name = data?.confirmation.name ?? branch.name;
  const code = data?.confirmation.code ?? branch.code;
  const matches = normalizeName(typedName) === normalizeName(name) && typedCode.trim() === code;

  async function handleForceDelete() {
    if (inFlight.current || !data || !operationId.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const id = operationId.current;
    storeOperation(branch.id, id);
    try {
      const result = await startForceDeletion(branch.id, {
        operation_id: id,
        confirm_name: typedName,
        confirm_code: typedCode,
        version: data.confirmation.version,
        plan_keys: data.confirmation.plan_keys,
        plan_hash: data.confirmation.plan_hash,
        confirmation_token: data.confirmation.confirmation_token,
        acknowledge: true,
      });
      applyStatus(result);
    } catch (startError) {
      // The request may have reached the server although no answer came
      // back. Ask about this exact operation before reporting anything.
      const found = await fetchForceDeletionStatus(id).catch(() => undefined);
      if (found) {
        applyStatus(found);
      } else {
        if (found === null) storeOperation(branch.id, null);
        setError(startError instanceof Error ? startError.message : 'Force Delete failed');
        void plan.refetch();
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function handleStop() {
    if (!status?.operation_id) return;
    try {
      applyStatus(await abortForceDeletion(status.operation_id));
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Could not stop the Force Delete');
    }
  }

  const closeButton = (label: string) => (
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
      {label}
    </Button>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (status?.status === 'fenced') {
    body = (
      <div className="space-y-3 text-sm" role="status">
        <p className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Force Delete in progress. The branch is
          locked: nothing new can be recorded there.
        </p>
        {status.last_error && (
          <p className="text-destructive">
            Not finished yet: {status.last_error} It is retried automatically.
          </p>
        )}
        <p className="text-muted-foreground">
          You can close this window; the operation continues and reopening shows its status.
        </p>
      </div>
    );
    footer = (
      <>
        {closeButton('Close')}
        <Button type="button" variant="outline" onClick={() => void handleStop()}>
          Stop and keep the branch
        </Button>
      </>
    );
  } else if (plan.isLoading) {
    body = (
      <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking this branch…
      </div>
    );
    footer = closeButton('Cancel');
  } else if (plan.isError || !data) {
    body = (
      <p className="text-destructive text-sm" role="alert">
        {plan.error instanceof Error ? plan.error.message : 'Could not prepare Force Delete.'}
      </p>
    );
    footer = closeButton('Close');
  } else {
    body = (
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1 text-sm">
        <div className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Force Delete removes {name} (<span className="font-mono">{code}</span>) even though it
            still has open work. It can’t be undone in the application.
          </span>
        </div>
        {data.groups.length === 0 ? (
          <p className="text-muted-foreground">
            No open work was found. Normal Delete would also work.
          </p>
        ) : (
          <div>
            <p className="font-medium">Open work and what happens to it</p>
            <ul className="mt-1 space-y-2" data-testid="force-delete-groups">
              {data.groups.map((group) => (
                <li key={group.kind} className="rounded-md border p-2">
                  <p className="font-medium">
                    {group.count} × {group.kind.replaceAll('_', ' ')}
                  </p>
                  <p className="text-muted-foreground">{group.explanation}</p>
                  {group.examples.length > 0 && (
                    <ul className="text-muted-foreground mt-1 list-disc pl-5 text-xs">
                      {group.examples.slice(0, 5).map((example) => (
                        <li key={example}>{example}</li>
                      ))}
                      {group.count > 5 && <li>…and {group.count - 5} more</li>}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="font-medium">Kept</p>
          <p className="text-muted-foreground mt-1">
            Every sale, payment, expense, supply issue, proof, payroll run and stock movement stays
            under this branch’s name and code. Other branches’ stock and transfers are not touched.
            Each unresolved item above is kept in a read-only closure record you can reconcile
            later.
          </p>
        </div>
        <div>
          <p className="font-medium">Removed</p>
          <p className="text-muted-foreground mt-1">
            The branch, its settings and its own branch login ({data.removed.branch_accounts ?? 0}),
            signed out at once. Staff and supervisors keep their accounts without this branch.
            {(data.removed.branch_accounts ?? 0) > 0 &&
              ' The branch login’s email can be used again for a new account, which starts fresh with a new ID and none of the old login’s records, sessions or access.'}
          </p>
        </div>
        <p className="border-warning/40 bg-warning/10 text-muted-foreground rounded-md border p-2">
          {data.offline_notice}
        </p>
        <div className="space-y-2">
          <Label htmlFor="force-delete-name">
            Type the branch name <span className="font-semibold">{name}</span>
          </Label>
          <Input
            id="force-delete-name"
            autoComplete="off"
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="force-delete-code">
            Type the branch code <span className="font-mono font-semibold">{code}</span>
          </Label>
          <Input
            id="force-delete-code"
            autoComplete="off"
            value={typedCode}
            onChange={(event) => setTypedCode(event.target.value)}
          />
        </div>
        <label className="flex items-start gap-2" htmlFor="force-delete-ack">
          <Checkbox
            id="force-delete-ack"
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          <span>
            I understand open shifts and clock-ins are ended without a cash count or clock-out,
            stock is recorded but not counted, and these items stay unresolved until reconciled.
          </span>
        </label>
        {error && (
          <p className="text-destructive text-sm" role="alert">
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
          disabled={!matches || !acknowledged || submitting}
          onClick={() => void handleForceDelete()}
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Force delete branch
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>Force delete {name}?</DialogTitle>
          <DialogDescription>
            For a branch that can’t be deleted normally. Review every item below.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
