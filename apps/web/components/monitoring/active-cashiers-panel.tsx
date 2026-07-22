'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { useShifts, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useBranches } from '@/hooks/queries/use-branches';
import { useEmployees } from '@/hooks/queries/use-employees';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

const LIST_LIMIT = 100;

/** mm:ss / hh:mm:ss shift duration, ticking every second while any shift is displayed. */
function formatDuration(startedAt: string, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function ActiveCashiersPanel() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const isLoadingAuth = useAuthStore((state) => state.isLoading);
  useShiftsRealtimeSync();

  const { data: shiftsData, isLoading: isLoadingShifts } = useShifts({ status: 'active', limit: LIST_LIMIT });
  const { data: branchesData, isLoading: isLoadingBranches } = useBranches({ limit: LIST_LIMIT });
  const { data: employeesData, isLoading: isLoadingEmployees } = useEmployees({ limit: LIST_LIMIT });

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const isLoading = !accessToken || isLoadingAuth || isLoadingShifts || isLoadingBranches || isLoadingEmployees;

  const branchNameById = new Map((branchesData?.branches ?? []).map((b) => [b.id, b.name]));
  const employeeNameById = new Map(
    (employeesData?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]),
  );
  const shifts = shiftsData?.shifts ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" />
          Active Cashiers
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : shifts.length === 0 ? (
          <EmptyState icon={Users} title="No active shifts" />
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {shifts.map((shift) => (
              <div key={shift.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{employeeNameById.get(shift.cashier_id) ?? 'Unknown cashier'}</p>
                  <p className="truncate text-xs text-muted-foreground">{branchNameById.get(shift.branch_id) ?? 'Unknown branch'}</p>
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <p>Started {new Date(shift.started_at).toLocaleTimeString()}</p>
                  <p className="font-mono">{formatDuration(shift.started_at, now)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
