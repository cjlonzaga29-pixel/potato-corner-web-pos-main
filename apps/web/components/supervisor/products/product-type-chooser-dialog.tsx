'use client';

import { PRODUCT_CLASSIFICATIONS, PRODUCT_CLASSIFICATION_LABELS, type ProductClassification } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const DESCRIPTIONS: Record<ProductClassification, string> = {
  regular: 'An everyday menu item.',
  promotional: 'An item sold for a promotion.',
  seasonal: 'A limited-time item.',
};

interface ProductTypeChooserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (classification: ProductClassification) => void;
}

/**
 * POS-PERF-P57 — the first step of Create Product. It only preselects the
 * existing classification in the builder: a type alone gives no discount and
 * doesn't publish anything.
 */
export function ProductTypeChooserDialog({ open, onOpenChange, onChoose }: ProductTypeChooserDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>What type of product is this?</DialogTitle>
          <DialogDescription>You can change this in the builder. The type alone doesn&apos;t discount the product or put it on the POS.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {PRODUCT_CLASSIFICATIONS.map((classification) => (
            <Button
              key={classification}
              type="button"
              variant="outline"
              className="h-auto min-h-12 w-full flex-col items-start whitespace-normal py-3 text-left"
              data-testid={`product-type-${classification}`}
              onClick={() => onChoose(classification)}
            >
              <span className="font-medium">{PRODUCT_CLASSIFICATION_LABELS[classification]}</span>
              <span className="text-xs font-normal text-muted-foreground">{DESCRIPTIONS[classification]}</span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
