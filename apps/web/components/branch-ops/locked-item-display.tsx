import { Lock } from 'lucide-react';

interface LockedItemDisplayProps {
  name: string;
  unitCode: string;
}

/**
 * POS-PERF-P29 — rendered instead of the item <Select> when a row action
 * launched the form with ?inventory_item_id= already in the URL. Read-only
 * by design: the user clicked a specific row, so re-offering a picker that
 * could be changed (or whose options could still be loading when the item
 * is set, racing the preselect) is exactly the wrong-item risk this closes.
 */
export function LockedItemDisplay({ name, unitCode }: LockedItemDisplayProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Item</p>
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">({unitCode})</span>
      </div>
    </div>
  );
}
