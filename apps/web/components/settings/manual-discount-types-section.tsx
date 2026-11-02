'use client';

import { useEffect, useState } from 'react';
import type { ManualDiscountTypeResponse } from '@potato-corner/shared';
import { Plus } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { useDeactivateManualDiscountType, useManualDiscountTypes } from '@/hooks/queries/use-manual-discount-types';
import { formatCurrency } from '@/lib/utils';
import { ManualDiscountTypeDialog } from './manual-discount-type-dialog';

/**
 * POS-PERF-P55 — Settings → Discount types, one branch at a time. A
 * supervisor manages the types of branches they supervise (the server
 * re-checks every save against live assignments); a Super Admin sees them
 * read-only. Types that sales used are deactivated, never deleted.
 */
export function ManualDiscountTypesSection() {
  const { availableBranches } = useSelectedBranch();
  const { user } = useAuth();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; editing: ManualDiscountTypeResponse | null }>({ open: false, editing: null });
  const [deactivating, setDeactivating] = useState<ManualDiscountTypeResponse | null>(null);
  const deactivate = useDeactivateManualDiscountType();

  useEffect(() => {
    if (availableBranches.length === 0) return;
    if (!branchId || !availableBranches.some((b) => b.id === branchId)) setBranchId(availableBranches[0]?.id ?? null);
  }, [availableBranches, branchId]);

  const { data, isLoading, isError, error, refetch } = useManualDiscountTypes(branchId);
  const branchName = availableBranches.find((b) => b.id === branchId)?.name ?? 'this branch';
  // Writes are supervisor-only (the server enforces it; this only hides controls that would be refused).
  const canManage = user?.role === 'supervisor';
  const active = data?.filter((t) => t.is_active) ?? [];
  const inactive = data?.filter((t) => !t.is_active) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discount types</CardTitle>
        <CardDescription>
          The discounts cashiers can choose from at checkout. Nothing is applied automatically, and a branch with no types offers only &ldquo;No discount&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {availableBranches.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no active branch assignments.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              {availableBranches.length > 1 ? (
                <div className="w-full max-w-xs space-y-1">
                  <Label htmlFor="manual-types-branch">Branch</Label>
                  <Select value={branchId ?? undefined} onValueChange={setBranchId}>
                    <SelectTrigger id="manual-types-branch">
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
                  Branch: <span className="font-medium">{branchName}</span>
                </p>
              )}
              {canManage && branchId && (
                <Button onClick={() => setDialog({ open: true, editing: null })} disabled={!data}>
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                  New discount type
                </Button>
              )}
            </div>

            {(isLoading || (!data && !isError)) && branchId && <Skeleton className="h-32 w-full" />}
            {isError && (
              <div role="alert" className="rounded-md border p-3 text-sm">
                Couldn&apos;t load discount types for {branchName} ({error.message}).{' '}
                <button type="button" className="underline" onClick={() => void refetch()}>
                  Retry
                </button>
              </div>
            )}

            {data && active.length === 0 && (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="manual-types-empty">
                No discount types yet at {branchName}. Cashiers can only choose &ldquo;No discount&rdquo; until you add one.
              </p>
            )}

            {active.length > 0 && (
              <ul className="divide-y rounded-md border" aria-label={`Discount types at ${branchName}`}>
                {active.map((type) => (
                  <li key={type.id} className="flex flex-wrap items-center justify-between gap-3 p-3" data-testid={`manual-type-${type.id}`}>
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium break-words">{type.name}</p>
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        <Badge variant={type.apply_to_pos ? 'default' : 'secondary'}>{type.apply_to_pos ? 'On POS' : 'Not on POS'}</Badge>
                        <Badge variant="outline">{type.amount_mode === 'fixed' && type.fixed_amount !== null ? `Fixed ${formatCurrency(type.fixed_amount)}` : 'Staff enters amount'}</Badge>
                        <Badge variant="outline">{type.product_scope === 'selected' ? `${type.product_ids.length} product${type.product_ids.length === 1 ? '' : 's'}` : 'All products'}</Badge>
                        {type.require_proof && <Badge variant="outline">Proof photo required</Badge>}
                        {type.branch_ids.length > 1 && <Badge variant="outline">{type.branch_ids.length} branches</Badge>}
                        {type.sale_count > 0 && (
                          <span className="text-muted-foreground">
                            Used in {type.sale_count} sale{type.sale_count === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </div>
                    {type.can_edit && (
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, editing: type })}>
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setDeactivating(type)}>
                          Deactivate
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {inactive.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Deactivated ({inactive.length})</summary>
                <ul className="mt-2 space-y-1 pl-4 text-muted-foreground">
                  {inactive.map((type) => (
                    <li key={type.id}>
                      {type.name}
                      {type.sale_count > 0 ? ` — kept for ${type.sale_count} past sale${type.sale_count === 1 ? '' : 's'}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {!canManage && <p className="text-xs text-muted-foreground">Discount types are managed by the supervisors of each branch.</p>}
            {canManage && (
              <p className="text-xs text-muted-foreground">
                Changes apply to new sales only. Past sales keep the type name and amount they were rung with.
              </p>
            )}
          </>
        )}
      </CardContent>

      {branchId && (
        <ManualDiscountTypeDialog
          open={dialog.open}
          onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
          branches={availableBranches}
          branchId={branchId}
          editing={dialog.editing}
        />
      )}

      <AlertDialog open={deactivating !== null} onOpenChange={(open) => !open && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Deactivate &ldquo;{deactivating?.name}&rdquo; at {branchName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Cashiers will no longer see it at checkout. Past sales that used it keep their records and proof photos. This cannot be undone; you can
              create a new type with the same name later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deactivating) deactivate.mutate({ id: deactivating.id, expected_version: deactivating.version });
                setDeactivating(null);
              }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
