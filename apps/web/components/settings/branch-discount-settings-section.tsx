'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { useBranchDiscountSettings } from '@/hooks/queries/use-settings';
import { BranchDiscountSettingsForm } from './branch-discount-settings-form';

/**
 * POS-PERF-P50R — Settings → Discounts & VAT, one branch at a time. A
 * supervisor sees only branches they manage (the server re-checks every
 * read and save against live assignments); a Super Admin sees every active
 * branch and can also record VAT registration.
 */
export function BranchDiscountSettingsSection() {
  const { availableBranches } = useSelectedBranch();
  const [branchId, setBranchId] = useState<string | null>(null);

  useEffect(() => {
    if (availableBranches.length === 0) return;
    if (!branchId || !availableBranches.some((b) => b.id === branchId)) setBranchId(availableBranches[0]?.id ?? null);
  }, [availableBranches, branchId]);

  const { data, isLoading, isError, error, refetch } = useBranchDiscountSettings(branchId);
  const selectedName = availableBranches.find((b) => b.id === branchId)?.name;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discounts &amp; VAT by branch</CardTitle>
        <CardDescription>
          Each branch follows the organization default unless you set a rate for that branch. Saving here changes only the selected branch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {availableBranches.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no active branch assignments.</p>
        ) : (
          <>
            {availableBranches.length > 1 ? (
              <div className="max-w-xs space-y-1">
                <Label htmlFor="discount-branch">Branch</Label>
                <Select value={branchId ?? undefined} onValueChange={setBranchId}>
                  <SelectTrigger id="discount-branch">
                    <SelectValue placeholder="Choose a branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBranches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm">
                Branch: <span className="font-medium">{selectedName}</span>
              </p>
            )}

            {(isLoading || (!data && !isError)) && <Skeleton className="h-64 w-full" />}
            {isError && (
              <div role="alert" className="rounded-md border p-3 text-sm">
                Couldn&apos;t load discount settings for {selectedName ?? 'this branch'} ({error.message}).{' '}
                <button type="button" className="underline" onClick={() => void refetch()}>
                  Retry
                </button>
              </div>
            )}
            {data && <BranchDiscountSettingsForm key={data.branchId} data={data} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
