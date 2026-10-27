'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { useAllBranchWorkHours } from '@/hooks/queries/use-settings';
import { formatManilaDateTime } from '@/lib/manila-date';

/**
 * POS-PERF-P40 — Admin's read-only view of Work Hours. Editing moved to the
 * Supervisor console (per assigned branch). Shows the default every branch
 * falls back to and each branch's effective value and source.
 */
export function WorkHoursOverviewSection() {
  const { data, isLoading, isError, refetch } = useAllBranchWorkHours();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work Hours</CardTitle>
        <CardDescription>
          Read-only. Supervisors set regular hours for their own branches in the Supervisor console. Branches without their own setting use the
          default. Changes apply to clock-outs saved afterwards; past attendance is never recalculated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <Skeleton className="h-24 w-full" />}
        {isError && <ErrorState retry={() => void refetch()} />}
        {data && (
          <>
            <p className="text-sm">
              Default: <span className="font-semibold">{data.global.regularHours} hours</span>
              {data.global.updatedAt && <span className="text-muted-foreground"> · set {formatManilaDateTime(data.global.updatedAt)}</span>}
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <caption className="sr-only">Regular work hours by branch</caption>
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Branch</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Hours</th>
                    <th scope="col" className="px-3 py-2 font-medium">Source</th>
                    <th scope="col" className="px-3 py-2 font-medium">Last changed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.branches.map((branch) => (
                    <tr key={branch.branchId} className="border-t">
                      <td className="px-3 py-2">{branch.branchName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{branch.regularHours}</td>
                      <td className="px-3 py-2">{branch.source === 'branch' ? 'Branch setting' : 'Default'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {branch.source === 'branch' && branch.updatedAt ? formatManilaDateTime(branch.updatedAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
