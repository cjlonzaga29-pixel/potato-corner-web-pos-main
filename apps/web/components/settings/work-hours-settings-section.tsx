'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkHoursPolicy, useUpdateWorkHoursPolicy } from '@/hooks/queries/use-settings';

const MIN_HOURS = 1;
const MAX_HOURS = 24;

/**
 * P3D-P4 — the ONE place Super Admin configures how many hours count as a
 * regular shift before overtime begins. Read-only for every other role
 * (server-enforced by the PUT route's adminOnly gate, not by hiding this
 * component — same precedent as DiscountSettingsSection). Writes
 * GET/PUT /api/settings/work-hours, which attendance.service.ts's
 * getRegularShiftMinutes() resolves for both clock-out and manual-override
 * calculations.
 */
export function WorkHoursSettingsSection() {
  const { data: policy, isLoading, isError } = useWorkHoursPolicy();
  const updatePolicy = useUpdateWorkHoursPolicy();

  const [hours, setHours] = useState('8');

  useEffect(() => {
    if (!policy) return;
    setHours(String(policy.regularHours));
  }, [policy]);

  const parsedHours = Number(hours);
  const isInvalid = hours.trim() === '' || !Number.isFinite(parsedHours) || parsedHours < MIN_HOURS || parsedHours > MAX_HOURS;

  function handleSave() {
    if (isInvalid) return;
    updatePolicy.mutate({ regularHours: parsedHours });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work Hours</CardTitle>
        <CardDescription>Hours before overtime begins. Applies to every branch&apos;s clock-out and manual attendance corrections.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-12 w-full" />}

        {isError && <p className="text-sm text-destructive">Failed to load work hours settings.</p>}

        {!isLoading && !isError && (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <Label htmlFor="regular-work-hours" className="font-medium">
                Regular Work Hours
              </Label>
              <Input
                id="regular-work-hours"
                type="number"
                min={MIN_HOURS}
                max={MAX_HOURS}
                step="0.5"
                className="w-20 text-right"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>

            {isInvalid && (
              <p className="text-xs text-destructive">
                Regular Work Hours must be a number between {MIN_HOURS} and {MAX_HOURS}.
              </p>
            )}

            {policy?.updatedAt && (
              <p className="text-xs text-muted-foreground">Last updated {new Date(policy.updatedAt).toLocaleString()}</p>
            )}

            <Button onClick={handleSave} disabled={updatePolicy.isPending || isInvalid}>
              {updatePolicy.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
