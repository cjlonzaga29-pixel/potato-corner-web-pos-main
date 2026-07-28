'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useProductOptionGroups } from '@/hooks/queries/use-product-options';
import { useAssignVariantOptionGroup } from '@/hooks/queries/use-product-options';

interface AssignOptionGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  assignedGroupIds: string[];
}

export function AssignOptionGroupDialog({ open, onOpenChange, productId, variantId, assignedGroupIds }: AssignOptionGroupDialogProps) {
  const { data, isLoading } = useProductOptionGroups({ isActive: true, limit: 100 });
  const assignGroup = useAssignVariantOptionGroup(productId, variantId);

  const [optionGroupId, setOptionGroupId] = useState<string>('');

  const availableGroups = useMemo(
    () => (data?.option_groups ?? []).filter((group) => !assignedGroupIds.includes(group.id)),
    [data, assignedGroupIds],
  );

  function handleOpenChange(next: boolean) {
    if (next) setOptionGroupId('');
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!optionGroupId) return;
    await assignGroup.mutateAsync({ option_group_id: optionGroupId });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Assign Option Group</DialogTitle>
          <DialogDescription>Option groups already assigned to this variant are hidden from the list.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>Option Group</Label>
          <Select value={optionGroupId} onValueChange={setOptionGroupId} disabled={isLoading}>
            <SelectTrigger>
              <SelectValue placeholder={isLoading ? 'Loading…' : 'Select an option group'} />
            </SelectTrigger>
            <SelectContent>
              {availableGroups.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No unassigned option groups available</div>
              ) : (
                availableGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name} ({group.selection_type === 'SINGLE' ? 'Single' : 'Multiple'})
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!optionGroupId || assignGroup.isPending}>
            {assignGroup.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
