'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useBranches } from '@/hooks/queries/use-branches';
import { useAssignInventoryItemToBranches, useInventoryItem } from '@/hooks/queries/use-universal-inventory';
import { ItemUnitConversionsSection } from '@/components/admin/inventory/item-unit-conversions-section';

export default function InventoryItemDetailPage() {
  const params = useParams<{ itemId: string }>();
  const itemId = params.itemId;
  const { data: item, isLoading } = useInventoryItem(itemId);
  const { data: branchList } = useBranches({ limit: 100 });
  const assignToBranches = useAssignInventoryItemToBranches(itemId);
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([]);

  if (isLoading || !item) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const assignedBranchIds = new Set(item.assigned_branches.map((b) => b.branch_id));
  const unassignedBranches = (branchList?.branches ?? []).filter((b) => !assignedBranchIds.has(b.id));

  function toggleBranch(branchId: string, checked: boolean) {
    setSelectedBranchIds((prev) => (checked ? [...prev, branchId] : prev.filter((id) => id !== branchId)));
  }

  async function handleAssign() {
    if (selectedBranchIds.length === 0) return;
    await assignToBranches.mutateAsync({ branch_ids: selectedBranchIds });
    setSelectedBranchIds([]);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{item.name}</h1>
        <p className="text-sm text-muted-foreground">
          {item.sku ?? 'No SKU'} · Base unit: {item.base_unit_code} · Category: {item.category_name ?? 'Uncategorized'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Assigned Branches</CardTitle>
        </CardHeader>
        <CardContent>
          {item.assigned_branches.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not yet assigned to any branch.</p>
          ) : (
            <div className="space-y-2">
              {item.assigned_branches.map((assignment) => (
                <div key={assignment.branch_id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <span>
                    {assignment.branch_name} ({assignment.branch_code})
                  </span>
                  <Badge variant="active">{assignment.quantity_on_hand} {item.base_unit_code} on hand</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assign to Branches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {unassignedBranches.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every branch is already assigned this item.</p>
          ) : (
            <>
              <div className="space-y-2">
                {unassignedBranches.map((branch) => (
                  <label key={branch.id} className="flex items-center gap-3 rounded-md border p-3 text-sm">
                    <Checkbox
                      checked={selectedBranchIds.includes(branch.id)}
                      onCheckedChange={(checked) => toggleBranch(branch.id, checked === true)}
                    />
                    {branch.name} ({branch.code})
                  </label>
                ))}
              </div>
              <Button onClick={() => void handleAssign()} disabled={selectedBranchIds.length === 0 || assignToBranches.isPending}>
                {assignToBranches.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Assign Selected Branches
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <ItemUnitConversionsSection itemId={item.id} />
    </div>
  );
}
