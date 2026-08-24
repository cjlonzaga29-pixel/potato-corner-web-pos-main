'use client';

import type { AttendanceResponse } from '@potato-corner/shared';
import { KpiCard } from '@/components/shared/charts/kpi-card';

interface AttendanceStatsProps {
  records: AttendanceResponse[];
  isLoading: boolean;
}

/**
 * Derived entirely from the current fetched page of records — there is no
 * aggregate attendance endpoint, so these are scoped labels ("This Page"),
 * not branch-wide totals. Worked/regular/overtime sums are integer minutes
 * summed first, then divided for display — never summed as formatted
 * strings — and only over closed (non-null actual_work_minutes) records, so
 * an open shift never fabricates a final total. Same decimal-hours + "h"
 * suffix convention as reports-view.tsx's "Total Hours Worked" KPI.
 */
export function AttendanceStats({ records, isLoading }: AttendanceStatsProps) {
  const clockedIn = records.filter((record) => record.clock_out_server_time === null).length;
  const corrections = records.filter((record) => record.status === 'corrected').length;

  const closedRecords = records.filter((record) => record.actual_work_minutes !== null);
  const totalWorkMinutes = closedRecords.reduce((sum, record) => sum + (record.actual_work_minutes ?? 0), 0);
  const overtimeMinutesSum = closedRecords.reduce((sum, record) => sum + record.overtime_minutes, 0);
  const regularMinutesSum = totalWorkMinutes - overtimeMinutesSum;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <KpiCard title="Records This Page" value={records.length} isLoading={isLoading} />
      <KpiCard title="Currently Clocked In" value={clockedIn} isLoading={isLoading} />
      <KpiCard title="Corrections" value={corrections} isLoading={isLoading} />
      <KpiCard title="Worked Hours" value={totalWorkMinutes / 60} suffix="h" isLoading={isLoading} />
      <KpiCard title="Regular Hours" value={regularMinutesSum / 60} suffix="h" isLoading={isLoading} />
      <KpiCard title="Overtime Hours" value={overtimeMinutesSum / 60} suffix="h" isLoading={isLoading} />
    </div>
  );
}
