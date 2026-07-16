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
 * not branch-wide totals.
 */
export function AttendanceStats({ records, isLoading }: AttendanceStatsProps) {
  const clockedIn = records.filter((record) => record.clock_out_server_time === null).length;
  const corrections = records.filter((record) => record.status === 'corrected').length;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <KpiCard title="Records This Page" value={records.length} isLoading={isLoading} />
      <KpiCard title="Currently Clocked In" value={clockedIn} isLoading={isLoading} />
      <KpiCard title="Corrections" value={corrections} isLoading={isLoading} />
    </div>
  );
}
