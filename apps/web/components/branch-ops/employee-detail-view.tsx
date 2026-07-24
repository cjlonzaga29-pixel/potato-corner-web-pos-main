'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useEmployee } from '@/hooks/queries/use-employees';
import { SupervisorEditEmployeeDialog } from '@/components/supervisor/employees/edit-employee-dialog';
import { SupervisorDeactivateEmployeeDialog } from '@/components/supervisor/employees/deactivate-employee-dialog';
import { SupervisorResetPasswordDialog } from '@/components/supervisor/employees/reset-password-dialog';
import { SupervisorAssignmentManagerDialog } from '@/components/supervisor/employees/assignment-manager-dialog';

/** Shared body behind both `/supervisor/employees/:employeeId` and `/branch/employees/:employeeId`. */
export function EmployeeDetailView({ employeeId, basePath }: { employeeId: string; basePath: string }) {
  const { data: employee, isLoading, isError, refetch } = useEmployee(employeeId);

  const [editOpen, setEditOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);

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

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={`${basePath}/employees`}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to branch staff
        </Link>
      </Button>

      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">
          {employee.first_name} {employee.last_name}
        </h1>
        <Badge variant="secondary">{ROLE_LABELS[employee.role]}</Badge>
        <StatusBadge status={employee.is_active ? 'active' : 'inactive'} type="employee" />
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
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Email</p>
                <p className="font-medium">{employee.email}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Employment Type</p>
                <p className="font-medium capitalize">{employee.employment_type.replace('_', ' ')}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Last Login</p>
                <p className="font-medium">{employee.last_login_at ? formatDateTime(employee.last_login_at) : 'Never'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Employee Since</p>
                <p className="font-medium">{formatDate(employee.created_at)}</p>
              </div>
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
              <Button size="sm" onClick={() => setAssignmentsOpen(true)}>
                Manage Assignments
              </Button>
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
              <CardDescription>Current status: {employee.is_active ? 'Active' : 'Inactive'}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span>Must change password on next login</span>
                <Badge variant={employee.must_change_password ? 'warning' : 'active'}>
                  {employee.must_change_password ? 'Yes' : 'No'}
                </Badge>
              </div>
              <Button variant="outline" onClick={() => setResetPasswordOpen(true)}>
                Reset Password
              </Button>
              {employee.is_active ? (
                <Button variant="danger" onClick={() => setDeactivateOpen(true)}>
                  Deactivate Employee
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This employee is deactivated. Reactivate from the employee list.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SupervisorEditEmployeeDialog open={editOpen} onOpenChange={setEditOpen} employee={employee} />
      <SupervisorDeactivateEmployeeDialog open={deactivateOpen} onOpenChange={setDeactivateOpen} employee={employee} />
      <SupervisorResetPasswordDialog open={resetPasswordOpen} onOpenChange={setResetPasswordOpen} employee={employee} />
      <SupervisorAssignmentManagerDialog open={assignmentsOpen} onOpenChange={setAssignmentsOpen} employee={employee} />
    </div>
  );
}
