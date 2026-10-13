'use client';

import { useParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ManagedElsewhereBanner } from '@/components/shared/managed-elsewhere-banner';
import { useInventoryItem } from '@/hooks/queries/use-universal-inventory';
import { ItemUnitConversionsSection } from '@/components/admin/inventory/item-unit-conversions-section';

export default function InventoryItemDetailPage() {
  const params = useParams<{ itemId: string }>();
  const itemId = params.itemId;
  const { data: item, isLoading } = useInventoryItem(itemId);

  if (isLoading || !item) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="app-title font-bold">{item.name}</h1>
        <p className="text-sm text-muted-foreground">
          {item.sku ?? 'No SKU'} · Base unit: {item.base_unit_code} · Category: {item.category_name ?? 'Uncategorized'}
        </p>
      </div>

      <ManagedElsewhereBanner module="Universal Inventory" managedBy="Supervisor" />

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
                  <Badge variant="active">
                    {assignment.quantity_on_hand} {item.base_unit_code} on hand
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ItemUnitConversionsSection itemId={item.id} readOnly />
    </div>
  );
}
