'use client';

import { Users, Clock, UserX } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { useAttendanceByBranch } from '@/hooks/queries/use-attendance';
import { useEmployees } from '@/hooks/queries/use-employees';

const ROSTER_LIMIT = 100;
const RECORDS_LIMIT = 100;

interface DashboardAttendanceOverviewProps {
  branchFilter: string | undefined;
}

function todayRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Super admin dashboard section — today's clock-in coverage for the selected
 * branch. useAttendanceByBranch has no cross-branch mode (it requires a
 * branch_id), so "All Branches" shows a selection prompt rather than a
 * fabricated aggregate.
 */
export function DashboardAttendanceOverview({ branchFilter }: DashboardAttendanceOverviewProps) {
  const { from, to } = todayRange();
  const attendance = useAttendanceByBranch(branchFilter, { from, to, limit: RECORDS_LIMIT });
  const roster = useEmployees({ branchId: branchFilter, isActive: true, limit: ROSTER_LIMIT });

  const records = attendance.data?.records ?? [];
  const presentCount = new Set(records.map((record) => record.employee_id)).size;
  const lateCount = records.filter((record) => record.clock_in_time_flag).length;
  const rosterCount = roster.data?.total ?? 0;
  const absentCount = Math.max(rosterCount - presentCount, 0);

  const isLoading = attendance.isLoading || roster.isLoading;
  const isError = attendance.isError || roster.isError;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Attendance Overview</CardTitle>
      </CardHeader>
      <CardContent>
        {!branchFilter ? (
          <EmptyState
            title="Select a branch"
            description="Attendance is tracked per branch — pick a branch to see today's coverage."
          />
        ) : isError ? (
          <ErrorState
            title="Failed to load attendance"
            retry={() => {
              void attendance.refetch();
              void roster.refetch();
            }}
          />
        ) : !isLoading && rosterCount === 0 ? (
          <EmptyState title="No attendance data" description="No active employees found for this branch." />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard title="Present Today" value={presentCount} isLoading={isLoading} icon={Users} />
            <KpiCard
              title="Late"
              value={lateCount}
              isLoading={isLoading}
              icon={Clock}
              tone={lateCount > 0 ? 'warning' : 'default'}
            />
            <KpiCard
              title="Absent"
              value={absentCount}
              isLoading={isLoading}
              icon={UserX}
              tone={absentCount > 0 ? 'danger' : 'default'}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
