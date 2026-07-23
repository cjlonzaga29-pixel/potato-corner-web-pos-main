'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { ROLE_LABELS, type AuditLogResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { CopyButton } from '@/components/shared/copy-button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { RoleGuard } from '@/components/shared/role-guard';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useEmployee, useEmployeeActivity } from '@/hooks/queries/use-employees';
import { useAuditLogs } from '@/hooks/queries/use-audit-logs';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { PayrollDataDialog } from '@/components/admin/employees/payroll-data-dialog';

interface EmployeeDetailPageProps {
  params: Promise<{ employeeId: string }>;
}

export default function EmployeeDetailPage({ params }: EmployeeDetailPageProps) {
  const { employeeId } = use(params);
  const { data: employee, isLoading, isError, refetch } = useEmployee(employeeId);

  const [payrollOpen, setPayrollOpen] = useState(false);

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
        <Link href="/admin/employees">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to employees
        </Link>
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">
              {employee.first_name} {employee.last_name}
            </h1>
            <Badge variant="secondary">{ROLE_LABELS[employee.role]}</Badge>
            <StatusBadge status={employee.is_active ? 'active' : 'inactive'} type="employee" />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{employee.employee_id}</span>
            <CopyButton value={employee.employee_id} label="Copy employee ID" />
            <span>·</span>
            <span>{employee.email}</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact & Employment</CardTitle>
              <CardDescription>Basic profile information. Edit from the Supervisor console.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Email</p>
                <p className="font-medium">{employee.email}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Phone</p>
                <p className="font-medium">{employee.phone ?? 'Not set'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Employment Type</p>
                <p className="font-medium capitalize">{employee.employment_type.replace('_', ' ')}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Created</p>
                <p className="font-medium">{formatDate(employee.created_at)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Government IDs</CardTitle>
                <CardDescription>Values are encrypted at rest and never shown in plain text here.</CardDescription>
              </div>
              <RoleGuard allowedRoles={['super_admin']}>
                <Button variant="outline" size="sm" onClick={() => setPayrollOpen(true)}>
                  View Payroll Data
                </Button>
              </RoleGuard>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              {['SSS Number', 'PhilHealth Number', 'TIN', 'Pag-IBIG Number'].map((label) => (
                <div key={label}>
                  <p className="text-muted-foreground">{label}</p>
                  <p className="font-mono font-medium tracking-widest">••••••••</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="assignments" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Branch Assignments</CardTitle>
              <CardDescription>Branches this employee currently has access to. Manage from the Supervisor console.</CardDescription>
            </CardHeader>
            <CardContent>
              {employee.branch_assignments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active branch assignments.</p>
              ) : (
                <div className="space-y-2">
                  {employee.branch_assignments.map((assignment) => (
                    <div key={assignment.branch_id} className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">{assignment.branch_name}</p>
                        <p className="text-xs text-muted-foreground">{assignment.branch_code}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">Assigned {formatDate(assignment.assigned_at)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <ActivityTab employeeId={employeeId} />
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
              <p className="text-sm text-muted-foreground">
                Password resets and activation status changes are managed from the Supervisor console.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-start gap-2 py-6 text-sm text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Lockout controls and login attempt history land in a later phase (Audit &amp; Fraud Detection).</span>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RoleGuard allowedRoles={['super_admin']}>
        <PayrollDataDialog open={payrollOpen} onOpenChange={setPayrollOpen} employee={employee} />
      </RoleGuard>
    </div>
  );
}

const employeeActivityColumns: ColumnDef<AuditLogResponse>[] = [
  { id: 'created_at', header: 'Timestamp', cell: ({ row }) => formatDateTime(row.original.created_at) },
  { accessorKey: 'action', header: 'Action' },
  { accessorKey: 'entity_type', header: 'Entity Type' },
  { id: 'ip_address', header: 'IP Address', cell: ({ row }) => row.original.ip_address ?? '—' },
];

function ActivityTab({ employeeId }: { employeeId: string }) {
  const { data: activity, isLoading, isError, refetch } = useEmployeeActivity(employeeId);
  const auditLogs = useAuditLogs({ actor_id: employeeId, limit: 25 });

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }
  if (isError || !activity) {
    return <ErrorState retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Last Login" value={activity.last_login_at ? formatDateTime(activity.last_login_at) : 'Never'} />
        <StatTile label="Shifts This Month" value={String(activity.total_shifts_this_month)} />
        <StatTile label="Transactions This Month" value={String(activity.total_transactions_this_month)} />
        <StatTile
          label="Open Fraud Alerts"
          value={String(activity.open_fraud_alerts_count)}
          href={activity.open_fraud_alerts_count > 0 ? '/admin/reports?tab=FRAUD_ALERT_SUMMARY' : undefined}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity Log</CardTitle>
          <CardDescription>Audit log entries for this employee.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={employeeActivityColumns}
            data={auditLogs.data?.logs ?? []}
            isLoading={auditLogs.isLoading}
            isError={auditLogs.isError}
            onRetry={() => void auditLogs.refetch()}
            emptyState={<EmptyState title="No activity recorded" description="No audit log entries for this employee yet." />}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({ label, value, href }: { label: string; value: string; href?: string }) {
  const content = (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}
