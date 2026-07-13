'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, MapPin, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/shared/status-badge';
import { CopyButton } from '@/components/shared/copy-button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useBranch, useBranchAssignments, useBranchStats, useRemoveSupervisor, useChangeBranchStatus } from '@/hooks/queries/use-branches';
import { EditBranchDialog } from '@/components/admin/branches/edit-branch-dialog';
import { ChangeStatusDialog } from '@/components/admin/branches/change-status-dialog';
import { AssignSupervisorDialog } from '@/components/admin/branches/assign-supervisor-dialog';

interface BranchDetailPageProps {
  params: Promise<{ branchId: string }>;
}

export default function BranchDetailPage({ params }: BranchDetailPageProps) {
  const { branchId } = use(params);
  const { data: branch, isLoading, isError, refetch } = useBranch(branchId);

  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !branch) {
    return <ErrorState title="Branch not found" retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/admin/branches">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to branches
        </Link>
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{branch.name}</h1>
            <StatusBadge status={branch.status} />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{branch.code}</span>
            <CopyButton value={branch.code} label="Copy branch code" />
            <span>·</span>
            <span>{branch.city}</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="statistics">Statistics</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <OverviewTab branchId={branchId} address={branch.address} gpsLatitude={branch.gpsLatitude} gpsLongitude={branch.gpsLongitude} gpsRadiusMeters={branch.gpsRadiusMeters} />
        </TabsContent>

        <TabsContent value="assignments" className="space-y-4">
          <AssignmentsTab branchId={branchId} onAddSupervisor={() => setAssignOpen(true)} />
        </TabsContent>

        <TabsContent value="statistics" className="space-y-4">
          <StatisticsTab branchId={branchId} />
        </TabsContent>

        <TabsContent value="settings" className="space-y-4">
          <SettingsTab branch={branch} onEdit={() => setEditOpen(true)} onChangeStatus={() => setStatusOpen(true)} />
        </TabsContent>
      </Tabs>

      <EditBranchDialog open={editOpen} onOpenChange={setEditOpen} branch={branch} />
      <ChangeStatusDialog open={statusOpen} onOpenChange={setStatusOpen} branch={branch} />
      <AssignSupervisorDialog open={assignOpen} onOpenChange={setAssignOpen} branchId={branchId} />
    </div>
  );
}

interface OverviewTabProps {
  branchId: string;
  address: string;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsRadiusMeters: number;
}

function OverviewTab({ branchId, address, gpsLatitude, gpsLongitude, gpsRadiusMeters }: OverviewTabProps) {
  const { data: stats } = useBranchStats(branchId);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branch Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="text-muted-foreground">Address</p>
            <p className="font-medium">{address}</p>
          </div>
          <div>
            <p className="text-muted-foreground">GPS Coordinates</p>
            {gpsLatitude !== null && gpsLongitude !== null ? (
              <p className="flex items-center gap-1.5 font-medium">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                {gpsLatitude.toFixed(6)}, {gpsLongitude.toFixed(6)}
              </p>
            ) : (
              <p className="text-muted-foreground">Not set</p>
            )}
          </div>
          <div>
            <p className="text-muted-foreground">GPS Radius</p>
            <p className="font-medium">{gpsRadiusMeters}m</p>
          </div>
          {/* No map library in the approved stack — showing coordinates as text is the locked design per this phase's spec. */}
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            {gpsLatitude !== null && gpsLongitude !== null
              ? `Map preview placeholder (${gpsLatitude.toFixed(4)}, ${gpsLongitude.toFixed(4)})`
              : 'No GPS coordinates set'}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <StatTile label="Today's Revenue" value={stats ? formatCurrency(stats.todayRevenue) : '—'} />
        <StatTile label="Transactions Today" value={stats ? String(stats.todayTransactionCount) : '—'} />
        <StatTile label="Active Staff" value={stats ? String(stats.activeStaffCount) : '—'} />
        <StatTile label="Low Stock Items" value={stats ? String(stats.lowStockIngredientCount) : '—'} />
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

function AssignmentsTab({ branchId, onAddSupervisor }: { branchId: string; onAddSupervisor: () => void }) {
  const { data: assignments, isLoading, isError, refetch } = useBranchAssignments(branchId);
  const removeSupervisor = useRemoveSupervisor(branchId);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Supervisor Assignments</CardTitle>
          <CardDescription>Supervisors with active access to this branch.</CardDescription>
        </div>
        <Button size="sm" onClick={onAddSupervisor}>
          <Plus className="mr-2 h-4 w-4" />
          Add Supervisor
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : isError ? (
          <ErrorState retry={() => void refetch()} />
        ) : !assignments || assignments.length === 0 ? (
          <EmptyState title="No supervisors assigned" description="Add a supervisor to give them access to this branch." />
        ) : (
          <div className="space-y-2">
            {assignments.map((assignment) => (
              <div key={assignment.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">
                    {assignment.firstName} {assignment.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground">{assignment.email}</p>
                  <p className="text-xs text-muted-foreground">Assigned {formatDate(assignment.assignedAt)}</p>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setRemovingUserId(assignment.userId)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={removingUserId !== null}
        onOpenChange={(open) => !open && setRemovingUserId(null)}
        title="Remove supervisor?"
        description="They will immediately lose access to this branch."
        variant="danger"
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removingUserId) await removeSupervisor.mutateAsync(removingUserId);
        }}
      />
    </Card>
  );
}

function StatisticsTab({ branchId }: { branchId: string }) {
  const { data: stats, isLoading, isError, refetch } = useBranchStats(branchId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }
  if (isError || !stats) {
    return <ErrorState retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Active Shifts" value={String(stats.activeShiftsCount)} />
        <StatTile label="Transactions Today" value={String(stats.todayTransactionCount)} />
        <StatTile label="Today's Revenue" value={formatCurrency(stats.todayRevenue)} />
        <StatTile label="Active Staff" value={String(stats.activeStaffCount)} />
        <StatTile label="Low Stock Items" value={String(stats.lowStockIngredientCount)} />
      </div>
      <Card>
        <CardContent className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Trend charts land in Phase 16 (Reporting System).
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsTab({
  branch,
  onEdit,
  onChangeStatus,
}: {
  branch: { id: string; name: string; status: string };
  onEdit: () => void;
  onChangeStatus: () => void;
}) {
  const changeStatus = useChangeBranchStatus(branch.id);
  const [confirmName, setConfirmName] = useState('');
  const canClose = confirmName.trim() === branch.name && branch.status !== 'closed';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branch Details</CardTitle>
          <CardDescription>Update name, address, and GPS settings.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onEdit}>
            Edit Branch Details
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          <CardDescription>Current status: {branch.status}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onChangeStatus}>
            Change Status
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
          <CardDescription>Closing a branch prevents any new shifts from starting there.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="confirm-branch-name">
              Type <span className="font-semibold">{branch.name}</span> to confirm
            </Label>
            <Input
              id="confirm-branch-name"
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              placeholder={branch.name}
              disabled={branch.status === 'closed'}
            />
          </div>
          <Button
            variant="danger"
            disabled={!canClose || changeStatus.isPending}
            onClick={() => void changeStatus.mutateAsync({ status: 'closed' })}
          >
            {branch.status === 'closed' ? 'Branch is closed' : 'Close Branch'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
