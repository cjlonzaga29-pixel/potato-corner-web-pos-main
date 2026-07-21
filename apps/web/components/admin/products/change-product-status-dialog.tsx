'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ROLES, type ChangeProductStatusInput, type ProductResponse, type ProductStatus } from '@potato-corner/shared';

type ChangeableStatus = ChangeProductStatusInput['status'];
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useBranchStore } from '@/stores/branch.store';
import { useChangeProductStatus } from '@/hooks/queries/use-products';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

interface ChangeProductStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductResponse;
}

interface StatusOption {
  value: ChangeableStatus;
  label: string;
}

/** Mirrors products.service.ts's GLOBAL_TRANSITIONS matrix exactly — archived has no outgoing transitions. */
const GLOBAL_TRANSITIONS: Record<ProductStatus, StatusOption[]> = {
  draft: [
    { value: 'active', label: 'Active' },
    { value: 'archived', label: 'Archived' },
  ],
  active: [
    { value: 'temporarily_unavailable', label: 'Temporarily Unavailable' },
    { value: 'discontinued', label: 'Discontinued' },
    { value: 'archived', label: 'Archived' },
  ],
  temporarily_unavailable: [
    { value: 'active', label: 'Active' },
    { value: 'archived', label: 'Archived' },
  ],
  discontinued: [
    { value: 'active', label: 'Active' },
    { value: 'archived', label: 'Archived' },
  ],
  archived: [],
};

const BRANCH_SCOPED_OPTIONS: StatusOption[] = [
  { value: 'active', label: 'Active in this branch' },
  { value: 'temporarily_unavailable', label: 'Temporarily unavailable in this branch' },
];

export function ChangeProductStatusDialog({ open, onOpenChange, product }: ChangeProductStatusDialogProps) {
  const { user } = useAuth();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const changeStatus = useChangeProductStatus(product.id);
  const [selected, setSelected] = useState<ChangeableStatus | ''>('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isSuperAdmin = user?.role === ROLES.SUPER_ADMIN;
  const globallyLocked = product.status === 'discontinued' || product.status === 'archived';
  const options = isSuperAdmin ? GLOBAL_TRANSITIONS[product.status] : BRANCH_SCOPED_OPTIONS;
  const canSubmit = isSuperAdmin || (!globallyLocked && Boolean(activeBranchId));

  function handleOpenChange(next: boolean) {
    if (next) setSelected('');
    onOpenChange(next);
  }

  async function handleSaveConfirmed() {
    if (!selected) return;
    await changeStatus.mutateAsync({
      status: selected,
      branch_id: isSuperAdmin ? undefined : (activeBranchId ?? undefined),
    });
    onOpenChange(false);
  }

  function handleSave() {
    if (!selected) return;
    if (selected === 'archived') {
      setConfirmOpen(true);
      return;
    }
    void handleSaveConfirmed();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change Product Status</DialogTitle>
          <DialogDescription>Current status: {product.status_label}</DialogDescription>
        </DialogHeader>

        {product.status === 'archived' ? (
          <p className="text-sm text-muted-foreground">Archived products are read-only and cannot change status.</p>
        ) : !isSuperAdmin && !activeBranchId ? (
          <p className="text-sm text-destructive">Select an active branch first.</p>
        ) : !isSuperAdmin && globallyLocked ? (
          <p className="text-sm text-destructive">
            This product is globally {product.status_label.toLowerCase()} and cannot be enabled at branch level.
          </p>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">No further transitions are available from this status.</p>
        ) : (
          <RadioGroup value={selected} onValueChange={(value) => setSelected(value as ChangeableStatus)} className="gap-3">
            {options.map((option) => (
              <div key={option.value} className="flex items-center gap-2">
                <RadioGroupItem value={option.value} id={`status-${option.value}`} />
                <Label htmlFor={`status-${option.value}`} className="font-normal">
                  {option.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}

        {(selected === 'discontinued' || selected === 'archived') && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {selected === 'archived'
                ? 'Archiving makes this product permanently read-only and unavailable at every branch.'
                : 'Discontinuing this product removes it from every branch until re-enabled.'}
            </span>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={!selected || !canSubmit || changeStatus.isPending}>
            {changeStatus.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Archive Product"
        description="Archiving makes this product permanently read-only and unavailable at every branch. This cannot be undone from this screen."
        confirmLabel="Archive"
        variant="danger"
        onConfirm={handleSaveConfirmed}
      />
    </Dialog>
  );
}
