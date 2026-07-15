'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useEmployee } from '@/hooks/queries/use-employees';

interface SupervisorEmployeeDetailPageProps {
  params: Promise<{ employeeId: string }>;
}

/**
 * Limited, read-only profile — no edit/deactivate/reset-password actions
 * and no government ID section at all (not masked values, not even the
 * section header). Supervisors who somehow reach this page never see
 * anything beyond what's already on the list page plus branch assignments.
 */
export default function SupervisorEmployeeDetailPage({ params }: SupervisorEmployeeDetailPageProps) {
  const { employeeId } = use(params);
  const { data: employee, isLoading, isError, refetch } = useEmployee(employeeId);

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
        <Link href="/supervisor/employees">
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>Read-only. Contact a Super Admin to make changes.</CardDescription>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branch Assignments</CardTitle>
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
    </div>
  );
}
