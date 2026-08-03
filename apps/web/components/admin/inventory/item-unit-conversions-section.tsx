'use client';

import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { InventoryItemUnitConversionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useDeleteInventoryItemConversion, useInventoryItemConversions, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { ItemConversionDialog } from './item-conversion-dialog';

interface ItemUnitConversionsSectionProps {
  itemId: string;
}

export function ItemUnitConversionsSection({ itemId }: ItemUnitConversionsSectionProps) {
  const { data: conversions, isLoading } = useInventoryItemConversions(itemId);
  const { data: units = [] } = useUnitsOfMeasure();
  const [dialogState, setDialogState] = useState<{ open: boolean; conversion: InventoryItemUnitConversionResponse | null }>({
    open: false,
    conversion: null,
  });
  const [pendingDelete, setPendingDelete] = useState<InventoryItemUnitConversionResponse | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Item-Specific Unit Conversions</CardTitle>
        <Button size="sm" onClick={() => setDialogState({ open: true, conversion: null })}>
          <Plus className="mr-2 h-4 w-4" />
          Add Conversion
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !conversions || conversions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No item-specific conversions configured.</p>
        ) : (
          <div className="space-y-2">
            {conversions.map((conversion) => (
              <div key={conversion.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                <span>
                  1 {conversion.from_unit_code} = {conversion.factor} {conversion.to_unit_code}
                  <span className="ml-2 text-muted-foreground">
                    ({conversion.from_unit_name} → {conversion.to_unit_name})
                  </span>
                </span>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Edit conversion"
                    onClick={() => setDialogState({ open: true, conversion })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Delete conversion" onClick={() => setPendingDelete(conversion)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ItemConversionDialog
        itemId={itemId}
        units={units}
        open={dialogState.open}
        onOpenChange={(open) => setDialogState((prev) => ({ ...prev, open }))}
        conversion={dialogState.conversion}
      />

      <DeleteConversionDialog itemId={itemId} conversion={pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)} />
    </Card>
  );
}

function DeleteConversionDialog({
  itemId,
  conversion,
  onOpenChange,
}: {
  itemId: string;
  conversion: InventoryItemUnitConversionResponse | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteConversion = useDeleteInventoryItemConversion(itemId, conversion?.id ?? '');

  return (
    <ConfirmDialog
      open={!!conversion}
      onOpenChange={onOpenChange}
      title={`Delete conversion "1 ${conversion?.from_unit_code ?? ''} = ${conversion?.factor ?? ''} ${conversion?.to_unit_code ?? ''}"?`}
      description="This removes only this mapping. Units and the inventory item are unaffected."
      confirmLabel="Delete"
      variant="danger"
      onConfirm={async () => { await deleteConversion.mutateAsync(); }}
    />
  );
}
