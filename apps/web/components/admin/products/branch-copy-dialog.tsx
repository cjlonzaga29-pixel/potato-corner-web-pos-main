'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { ProductDetailResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useForkProductToBranch } from '@/hooks/queries/use-products';

interface EligibleBranch {
  id: string;
  name: string;
}

interface BranchCopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductDetailResponse;
  eligibleBranches: EligibleBranch[];
}

/**
 * POS-PERF-P36R5 — "Create Branch Copy": offered when a supervisor has an
 * active assignment to at least one, but not every, branch this shared
 * product is configured at (catalog-authority.ts's full-coverage rule means
 * they cannot edit the shared rows in place). Creates a branch-exclusive
 * copy scoped to one of their eligible branches that they fully own.
 *
 * The POST is idempotent server-side (products.service.ts's
 * forkProductForBranch checks for an existing fork first) — a network
 * failure/retry, or re-opening this dialog for a branch that already has a
 * copy, always resolves to the same copy rather than creating a duplicate,
 * so this dialog's only job on success is to navigate to whatever product
 * id comes back.
 */
export function BranchCopyDialog({ open, onOpenChange, product, eligibleBranches }: BranchCopyDialogProps) {
  const router = useRouter();
  const fork = useForkProductToBranch(product.id);
  const [branchId, setBranchId] = useState('');

  const onlyEligibleBranch = eligibleBranches.length === 1 ? eligibleBranches[0] : undefined;

  useEffect(() => {
    // Single eligible branch: preselect it so there is nothing to choose.
    if (open) setBranchId(onlyEligibleBranch?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onlyEligibleBranch is derived from eligibleBranches every render; re-running on its identity change would fight the user's own selection
  }, [open]);

  async function handleCreate() {
    if (!branchId) return;
    const copy = await fork.mutateAsync(branchId);
    onOpenChange(false);
    router.push(`/supervisor/products/${copy.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !fork.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Branch Copy</DialogTitle>
          <DialogDescription>
            {product.name} is shared with other branches, so you can&apos;t edit it directly. Create a copy scoped to your own
            branch instead — you&apos;ll fully own and can freely edit the copy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {eligibleBranches.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="branch-copy-branch">Branch</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger id="branch-copy-branch">
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleBranches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : onlyEligibleBranch ? (
            <p>
              Branch: <span className="font-medium text-foreground">{onlyEligibleBranch.name}</span>
            </p>
          ) : (
            <p className="text-destructive">You have no active branch assignment this product is configured at.</p>
          )}

          <div className="rounded-md border p-3">
            <p className="font-medium">What&apos;s copied</p>
            <p className="text-muted-foreground">Product configuration, variants, recipes, and flavor slots / option groups.</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="font-medium">What&apos;s NOT copied</p>
            <p className="text-muted-foreground">Stock balances, sales, and movement history stay with the original product.</p>
          </div>
          <p className="text-muted-foreground">
            The copy starts as a draft and is not sold anywhere until you publish it. Other branches selling the original
            product are completely unaffected.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={fork.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleCreate()} disabled={!branchId || fork.isPending}>
            {fork.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Branch Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
