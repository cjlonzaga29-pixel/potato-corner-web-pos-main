'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { useBranchWorkHours, useClearBranchWorkHours, useSetBranchWorkHours } from '@/hooks/queries/use-settings';
import { formatManilaDateTime } from '@/lib/manila-date';

const MIN_HOURS = 1;
const MAX_HOURS = 24;

/**
 * POS-PERF-P40 — Supervisor Work Hours, one card per branch the supervisor
 * is assigned to. Saving writes only that branch's override (the server
 * re-checks the assignment); the global value stays the fallback for every
 * branch without one. Applies to clock-outs and attendance corrections saved
 * from now on — overtime already stored on past records is not recalculated.
 */
export function BranchWorkHoursSection() {
  const { availableBranches } = useSelectedBranch();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work Hours</CardTitle>
        <CardDescription>
          Regular hours per shift before overtime, for each of your branches. A change applies to clock-outs and corrections saved after it; past
          attendance keeps the overtime it was recorded with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {availableBranches.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no active branch assignments.</p>
        ) : (
          availableBranches.map((branch) => <BranchWorkHoursRow key={branch.id} branchId={branch.id} branchName={branch.name} />)
        )}
      </CardContent>
    </Card>
  );
}

function BranchWorkHoursRow({ branchId, branchName }: { branchId: string; branchName: string }) {
  const { data, isLoading, isError, refetch } = useBranchWorkHours(branchId);
  const save = useSetBranchWorkHours(branchId);
  const clear = useClearBranchWorkHours(branchId);
  const [hours, setHours] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const inputId = `work-hours-${branchId}`;

  useEffect(() => {
    if (data) setHours(String(data.regularHours));
  }, [data]);

  if (isLoading) return <Skeleton className="h-20 w-full" />;
  if (isError || !data) {
    return (
      <div className="rounded-md border p-3 text-sm" role="alert">
        Couldn&apos;t load work hours for {branchName}.{' '}
        <button type="button" className="underline" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const parsed = Number(hours);
  const invalid = hours.trim() === '' || !Number.isFinite(parsed) || parsed < MIN_HOURS || parsed > MAX_HOURS;
  const unchanged = !invalid && parsed === data.regularHours && data.source === 'branch';

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={inputId} className="font-medium">
            {branchName}
          </Label>
          <p className="text-xs text-muted-foreground">
            {data.source === 'branch'
              ? `Branch setting · default for other branches is ${data.globalHours}h`
              : `Using the default (${data.globalHours}h)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            type="number"
            min={MIN_HOURS}
            max={MAX_HOURS}
            step="0.5"
            className="w-20 text-right"
            value={hours}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${inputId}-error` : undefined}
            onChange={(e) => setHours(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">hours</span>
          <Button size="sm" disabled={invalid || unchanged || save.isPending} onClick={() => save.mutate({ regularHours: parsed })}>
            Save
          </Button>
          {data.source === 'branch' && (
            <Button size="sm" variant="ghost" disabled={clear.isPending} onClick={() => setConfirmReset(true)}>
              Use default
            </Button>
          )}
        </div>
      </div>
      {invalid && (
        <p id={`${inputId}-error`} className="text-xs text-destructive">
          Enter a number between {MIN_HOURS} and {MAX_HOURS}.
        </p>
      )}
      {data.source === 'branch' && data.updatedAt && <p className="text-xs text-muted-foreground">Last changed {formatManilaDateTime(data.updatedAt)}</p>}
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={`Use the default for ${branchName}?`}
        description={`${branchName} will go back to the default of ${data.globalHours} hours for clock-outs saved from now on. Past attendance is not changed.`}
        confirmLabel="Use default"
        onConfirm={async () => {
          await clear.mutateAsync();
        }}
      />
    </div>
  );
}
