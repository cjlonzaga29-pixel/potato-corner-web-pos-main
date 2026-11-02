'use client';

import type { ProductTypeResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRestoreFocus } from '@/hooks/use-restore-focus';

interface ProductTypeChooserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: ProductTypeResponse[];
  onChoose: (key: string) => void;
}

/**
 * POS-PERF-P57 — the first step of Create Product from All Types. It only
 * preselects the type in the builder: a type alone gives no discount and doesn't
 * publish anything. POS-PERF-P58 — lists the active types, custom ones included.
 */
export function ProductTypeChooserDialog({ open, onOpenChange, types, onChoose }: ProductTypeChooserDialogProps) {
  const restoreFocus = useRestoreFocus(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle>What type of product is this?</DialogTitle>
          <DialogDescription>You can change this in the builder. The type alone doesn&apos;t discount the product or put it on the POS.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto p-0.5">
          {types.filter((type) => type.is_active).map((type) => (
            <Button
              key={type.key}
              type="button"
              variant="outline"
              className="h-auto min-h-12 w-full flex-col items-start whitespace-normal py-3 text-left"
              data-testid={`product-type-${type.key}`}
              onClick={() => onChoose(type.key)}
            >
              <span className="font-medium [overflow-wrap:anywhere]">{type.name}</span>
              {type.description && <span className="text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{type.description}</span>}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
