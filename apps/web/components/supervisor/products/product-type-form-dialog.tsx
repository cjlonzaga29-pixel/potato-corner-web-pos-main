'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductTypeResponse } from '@potato-corner/shared';
import { createProductTypeSchema, updateProductTypeSchema } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useBranches } from '@/hooks/queries/use-branches';
import { useCreateProductType, useUpdateProductType } from '@/hooks/queries/use-product-types';
import { useRestoreFocus } from '@/hooks/use-restore-focus';

interface ProductTypeFormDialogProps {
  /** Null creates a new type. */
  type: ProductTypeResponse | null;
  defaultBranchId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (type: ProductTypeResponse) => void;
}

/**
 * POS-PERF-P58 — Create Product Type and Edit. Offers only the supervisor's own
 * assigned branches, and a branch already in the type's scope can't be removed:
 * products may be using it. The server checks all of this again.
 */
export function ProductTypeFormDialog({ type, defaultBranchId, onOpenChange, onSaved }: ProductTypeFormDialogProps) {
  const restoreFocus = useRestoreFocus();
  const { user } = useAuth();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const create = useCreateProductType();
  const update = useUpdateProductType(type?.id ?? '');
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [branchIds, setBranchIds] = useState<string[]>(type ? type.branches.map((b) => b.branch_id) : []);
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  const assigned = user?.branchIds ?? [];
  const myBranches = (branchData?.branches ?? []).filter((b) => assigned.includes(b.id)).sort((a, b) => a.name.localeCompare(b.name));
  const lockedBranchIds = type ? type.branches.map((b) => b.branch_id) : [];

  // A new type starts at the branch being viewed, or the only one there is.
  useEffect(() => {
    if (type || branchesLoading) return;
    const initial = defaultBranchId && assigned.includes(defaultBranchId) ? defaultBranchId : myBranches.length === 1 ? myBranches[0]?.id : undefined;
    if (initial) setBranchIds([initial]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the branches arrive
  }, [branchesLoading]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = type
      ? updateProductTypeSchema.safeParse({ name, description: description.trim() || null, branch_ids: branchIds, expected_version: type.version })
      : createProductTypeSchema.safeParse({ name, ...(description.trim() && { description }), branch_ids: branchIds });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check this form.');
      return;
    }
    try {
      const saved = type
        ? await update.mutateAsync(updateProductTypeSchema.parse(parsed.data))
        : await create.mutateAsync(createProductTypeSchema.parse(parsed.data));
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save this product type.');
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-md" onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle>{type ? `Edit ${type.name}` : 'Create Product Type'}</DialogTitle>
          <DialogDescription>
            A type groups products, like Marketing or One-time. It&apos;s only a label: it doesn&apos;t discount, expire or publish anything, and it doesn&apos;t change recipes, stock or tax.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-label={type ? 'Edit product type' : 'Create product type'}>
          <div className="space-y-2">
            <Label htmlFor="product-type-name">Name</Label>
            <Input id="product-type-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Marketing" autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product-type-description">Description (optional)</Label>
            <Textarea id="product-type-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={300} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium leading-none">Available at branches</legend>
            <div className="max-h-44 space-y-2 overflow-y-auto rounded-md border p-3">
              {branchesLoading && <p className="text-sm text-muted-foreground">Loading your branches…</p>}
              {myBranches.map((branch) => (
                <label key={branch.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={branchIds.includes(branch.id)}
                    disabled={lockedBranchIds.includes(branch.id)}
                    aria-label={branch.name}
                    onCheckedChange={(checked) => setBranchIds((current) => (checked === true ? [...new Set([...current, branch.id])] : current.filter((id) => id !== branch.id)))}
                  />
                  {branch.name}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {type ? 'You can add branches. To use a smaller set of branches, create a new type.' : 'A product can only use this type if it covers all of the product’s branches.'}
            </p>
          </fieldset>
          {error && (
            <p className="text-sm font-medium text-destructive" role="alert" data-testid="product-type-form-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {type ? 'Save Changes' : 'Create Product Type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
