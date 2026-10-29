'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, KeyRound, Trash2 } from 'lucide-react';
import { EMPLOYEE_STATUS_LABELS, ROLES, ROLE_LABELS } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useEmployee } from '@/hooks/queries/use-employees';
import { useStaffPinStatus } from '@/hooks/queries/use-staff-pin';
import { ManageStaffPinDialog } from '@/components/supervisor/employees/manage-staff-pin-dialog';
import { RemoveEmployeeDialog } from '@/components/supervisor/employees/remove-employee-dialog';
import { SupervisorEditEmployeeDialog } from '@/components/supervisor/employees/edit-employee-dialog';
import { SetEmployeeStatusDialog } from '@/components/supervisor/employees/set-employee-status-dialog';
import { SupervisorAssignmentManagerDialog } from '@/components/supervisor/employees/assignment-manager-dialog';

/** Shared body behind both `/supervisor/employees/:employeeId` and `/branch/employees/:employeeId`. */
export function EmployeeDetailView({ employeeId, basePath }: { employeeId: string; basePath: string }) {
  const router = useRouter();
  const { data: employee, isLoading, isError, refetch } = useEmployee(employeeId);
  const isStaff = employee?.role === ROLES.STAFF;
  const pinStatus = useStaffPinStatus(employeeId, isStaff);

  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !employee) {
    return <ErrorState title="Employee not found" retry={() => void refetch()} />;
  }

  const hasActivePin = Boolean(pinStatus.data?.has_pin && pinStatus.data.is_active);

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={`${basePath}/employees`}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to branch staff
        </Link>
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">
            {employee.first_name} {employee.last_name}
          </h1>
          <Badge variant="secondary">{ROLE_LABELS[employee.role]}</Badge>
          <StatusBadge status={employee.status} type="employee" />
        </div>
        {isStaff ? (
          <div className="flex flex-wrap gap-2">
            <Button variant={hasActivePin ? 'outline' : 'default'} size="sm" onClick={() => setPinOpen(true)}>
              <KeyRound className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {hasActivePin ? 'Reset PIN' : 'Set PIN'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Delete
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{ROLE_LABELS[employee.role]} accounts are managed by a Super Admin.</p>
        )}
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Profile</CardTitle>
                <CardDescription>Basic profile information.</CardDescription>
              </div>
              {isStaff && (
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  Edit
                </Button>
              )}
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Employee ID</p>
                <p className="font-mono font-medium">{employee.employee_id}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Position</p>
                <p className="font-medium">{employee.position ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Employment Type</p>
                <p className="font-medium capitalize">{employee.employment_type.replace('_', ' ')}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Active</p>
                <p className="font-medium">{employee.last_login_at ? formatDateTime(employee.last_login_at) : 'Never'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Employee Since</p>
                <p className="font-medium">{formatDate(employee.created_at)}</p>
              </div>
              {employee.notes && (
                <div className="col-span-2">
                  <p className="text-muted-foreground">Notes</p>
                  <p className="font-medium whitespace-pre-wrap">{employee.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="assignments" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Branch Assignments</CardTitle>
                <CardDescription>Branches this employee currently has access to.</CardDescription>
              </div>
              {isStaff && (
                <Button size="sm" onClick={() => setAssignmentsOpen(true)}>
                  Manage Assignments
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {employee.branch_assignments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active branch assignments.</p>
              ) : (
                <div className="space-y-2">
                  {employee.branch_assignments.map((assignment) => (
                    <div key={assignment.branch_id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                      <span className="font-medium">{assignment.branch_name}</span>
                      <span className="text-xs text-muted-foreground">{assignment.branch_code}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account Status</CardTitle>
              <CardDescription>
                Current status: {EMPLOYEE_STATUS_LABELS[employee.status]}. Employees have no login credentials of their
                own — they operate inside an authenticated Branch Account session.
              </CardDescription>
            </CardHeader>
            {isStaff && (
              <CardContent className="space-y-3">
                <Button variant="outline" onClick={() => setStatusOpen(true)}>
                  Change Status
                </Button>
              </CardContent>
            )}
          </Card>

          {isStaff && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">POS / Inventory PIN</CardTitle>
                  <CardDescription>
                    Used to sign in at the POS, clock in and confirm inventory changes. The PIN itself is never shown.
                  </CardDescription>
                </div>
                <Button size="sm" variant={hasActivePin ? 'outline' : 'default'} onClick={() => setPinOpen(true)}>
                  {hasActivePin ? 'Reset PIN' : 'Set PIN'}
                </Button>
              </CardHeader>
              <CardContent className="text-sm">
                {pinStatus.isLoading ? (
                  <span className="text-muted-foreground">Checking…</span>
                ) : pinStatus.isError ? (
                  <span className="text-destructive">Couldn&apos;t check PIN status.</span>
                ) : hasActivePin ? (
                  <span className="flex items-center gap-2">
                    <Badge variant="active">PIN set</Badge>
                    {pinStatus.data?.set_at && <span className="text-muted-foreground">since {formatDateTime(pinStatus.data.set_at)}</span>}
                  </span>
                ) : pinStatus.data?.has_pin ? (
                  <Badge variant="secondary">PIN off</Badge>
                ) : (
                  <Badge variant="warning">No PIN set</Badge>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <SupervisorEditEmployeeDialog open={editOpen} onOpenChange={setEditOpen} employee={employee} />
      <SetEmployeeStatusDialog open={statusOpen} onOpenChange={setStatusOpen} employee={employee} />
      <SupervisorAssignmentManagerDialog open={assignmentsOpen} onOpenChange={setAssignmentsOpen} employee={employee} />
      {isStaff && <ManageStaffPinDialog open={pinOpen} onOpenChange={setPinOpen} employee={employee} />}
      {isStaff && (
        <RemoveEmployeeDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          employee={employee}
          onDeleted={() => router.replace(`${basePath}/employees`)}
        />
      )}
    </div>
  );
}
