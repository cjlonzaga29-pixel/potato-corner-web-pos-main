'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink, KeyRound, Plus, Trash2, UserPlus } from 'lucide-react';
import { ROLES, type BranchResponse } from '@potato-corner/shared';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDate } from '@/lib/utils';
import { useBranchAccountsOverview, useBranchAssignments, useRemoveSupervisor } from '@/hooks/queries/use-branches';
import { EditBranchDialog } from '@/components/admin/branches/edit-branch-dialog';
import { ChangeStatusDialog } from '@/components/admin/branches/change-status-dialog';
import { AssignSupervisorDialog } from '@/components/admin/branches/assign-supervisor-dialog';
import { CreateBranchAccountDialog } from '@/components/admin/branches/create-branch-account-dialog';
import { EditBranchAccountDialog } from '@/components/admin/edit-branch-account-dialog';

export type BranchManageTab = 'details' | 'account' | 'supervisors';

export function isBranchManageTab(value: string | null): value is BranchManageTab {
  return value === 'details' || value === 'account' || value === 'supervisors';
}

interface BranchManagePanelProps {
  branch: BranchResponse;
  tab: BranchManageTab;
  onTabChange: (tab: BranchManageTab) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * POS-PERF-P40 — the single Manage surface for a branch, combining what used
 * to be split between Branches and Branch Accounts. Every action reuses the
 * existing dialog/endpoint (edit, status, credential update, supervisor
 * assign/remove), so server-side permissions and audit entries are
 * unchanged. Passwords are never displayed — only set.
 */
export function BranchManagePanel({ branch, tab, onTabChange, onOpenChange }: BranchManagePanelProps) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-1 text-left">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <SheetTitle>{branch.name}</SheetTitle>
            <StatusBadge status={branch.status} type="branch" />
          </div>
          <SheetDescription>
            <span className="font-mono">{branch.code}</span> · {branch.city}
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={(value) => isBranchManageTab(value) && onTabChange(value)} className="mt-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="supervisors">Supervisors</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4">
            <DetailsTab branch={branch} />
          </TabsContent>
          <TabsContent value="account" className="mt-4">
            <AccountTab branch={branch} />
          </TabsContent>
          <TabsContent value="supervisors" className="mt-4">
            <SupervisorsTab branchId={branch.id} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

function DetailsTab({ branch }: { branch: BranchResponse }) {
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Address">{branch.address}</Field>
        <Field label="City">{branch.city}</Field>
        <Field label="Status">
          <StatusBadge status={branch.status} type="branch" />
        </Field>
        <Field label="GPS radius">{branch.gpsRadiusMeters} m</Field>
        <Field label="Active supervisors">{branch.activeSupervisorCount}</Field>
        <Field label="Active staff">{branch.activeStaffCount}</Field>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          Edit details
        </Button>
        <Button variant="outline" size="sm" onClick={() => setStatusOpen(true)}>
          Change status
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/branches/${branch.id}`}>
            Full branch page
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        GCash QR, statistics, closing and permanent deletion are on the full branch page, each behind its own confirmation.
      </p>
      {editOpen && <EditBranchDialog open onOpenChange={setEditOpen} branch={branch} />}
      {statusOpen && <ChangeStatusDialog open onOpenChange={setStatusOpen} branch={branch} />}
    </div>
  );
}

function AccountTab({ branch }: { branch: BranchResponse }) {
  const { data, isLoading, isError, refetch } = useBranchAccountsOverview();
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }
  if (isError) return <ErrorState retry={() => void refetch()} />;

  const accounts = (data ?? []).filter((account) => account.branch_id === branch.id);
  const editing = accounts.find((account) => account.user_id === editingUserId) ?? null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">The login the branch&apos;s POS signs in with. Passwords are never shown — you can only set a new one.</p>
      {accounts.length === 0 ? (
        <EmptyState
          title="No branch account"
          description="This branch has no active login account."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Create branch account
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <li key={account.assignment_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{account.email}</p>
                <p className="text-xs text-muted-foreground">Branch login account</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditingUserId(account.user_id)}>
                <KeyRound className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Edit email or password
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <EditBranchAccountDialog open onOpenChange={(open) => !open && setEditingUserId(null)} account={editing} />}
      {createOpen && <CreateBranchAccountDialog open onOpenChange={setCreateOpen} branch={branch} />}
    </div>
  );
}

function SupervisorsTab({ branchId }: { branchId: string }) {
  const { data, isLoading, isError, refetch } = useBranchAssignments(branchId);
  // The endpoint returns every active assignment (staff, the branch login
  // account); this tab and its Remove action are for supervisors only — the
  // branch account is managed from the Account tab.
  const assignments = data?.filter((assignment) => assignment.role === ROLES.SUPERVISOR);
  const removeSupervisor = useRemoveSupervisor(branchId);
  const [assignOpen, setAssignOpen] = useState(false);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Supervisors with active access to this branch.</p>
        <Button size="sm" onClick={() => setAssignOpen(true)}>
          <UserPlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Assign supervisor
        </Button>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      ) : isError ? (
        <ErrorState retry={() => void refetch()} />
      ) : !assignments || assignments.length === 0 ? (
        <EmptyState title="No supervisors assigned" description="Assign a supervisor to give them access to this branch." />
      ) : (
        <ul className="space-y-2">
          {assignments.map((assignment) => {
            const name = `${assignment.firstName} ${assignment.lastName}`.trim();
            return (
              <li key={assignment.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{name}</p>
                  <p className="truncate text-xs text-muted-foreground">{assignment.email}</p>
                  <p className="text-xs text-muted-foreground">Assigned {formatDate(assignment.assignedAt)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive"
                  aria-label={`Remove ${name} from this branch`}
                  onClick={() => setRemoving({ userId: assignment.userId, name })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <AssignSupervisorDialog open={assignOpen} onOpenChange={setAssignOpen} branchId={branchId} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? `Remove ${removing.name}?` : 'Remove supervisor?'}
        description="They will immediately lose access to this branch. Their account is not deleted."
        variant="danger"
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removing) await removeSupervisor.mutateAsync(removing.userId);
        }}
      />
    </div>
  );
}
