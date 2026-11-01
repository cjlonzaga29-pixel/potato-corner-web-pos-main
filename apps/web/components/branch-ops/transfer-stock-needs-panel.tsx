'use client';

import { useId, type ReactNode } from 'react';
import { PackageCheck } from 'lucide-react';
import type { BranchInventoryStockRow } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { cn } from '@/lib/utils';
import { affectedLabel, otherChoicesStillSell, recipeShortageLine, stockBadgeStatus, stockNeeds, stockStateOf } from '@/lib/inventory-stock-status';

interface BranchOption {
  id: string;
  name: string;
}

interface TransferStockNeedsPanelProps {
  branches: BranchOption[];
  isBranchesLoading: boolean;
  destinationId: string;
  onDestinationChange: (branchId: string) => void;
  /** Destination rows — only ever the selected destination's (the caller drops a response answered for another branch). */
  rows: BranchInventoryStockRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  selectedItemId: string;
  onSelectNeed: (row: BranchInventoryStockRow) => void;
}

function formatQuantity(value: number, unit: string): string {
  return `${value} ${unit}`;
}

/**
 * POS-PERF-P48 — left/top pane of the transfer page: the destination's
 * out-of-stock, insufficient, critical and low items, by the same rule as the Inventory
 * page's "Needs attention" filter (judged on available stock).
 * Choosing a row only pre-fills the form; nothing is submitted from here.
 */
export function TransferStockNeedsPanel({
  branches,
  isBranchesLoading,
  destinationId,
  onDestinationChange,
  rows,
  isLoading,
  isError,
  onRetry,
  selectedItemId,
  onSelectNeed,
}: TransferStockNeedsPanelProps) {
  const selectId = useId();
  const destinationName = branches.find((b) => b.id === destinationId)?.name;
  const needs = rows ? stockNeeds(rows) : [];

  let body: ReactNode;
  if (!destinationId) {
    body = <p className="text-sm text-muted-foreground">Choose the branch that needs stock to see the items it is short of.</p>;
  } else if (isError) {
    body = (
      <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <p>Could not load stock for {destinationName ?? 'this branch'}.</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  } else if (isLoading || !rows) {
    body = (
      <div className="space-y-2" aria-busy="true" aria-label="Loading stock needs">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  } else if (needs.length === 0) {
    body = (
      <EmptyState
        compact
        icon={PackageCheck}
        title="No stock needs"
        description={`Every tracked item at ${destinationName ?? 'this branch'} has stock available, is above its thresholds and can cover a serving of what the POS offers. An item without thresholds and no recipe shortage is listed only when it runs out.`}
      />
    );
  } else {
    body = (
      <ul className="space-y-2" aria-label={`Stock needs at ${destinationName ?? 'destination'}`}>
        {needs.map((row) => {
          const selected = row.inventory_item_id === selectedItemId;
          const state = stockStateOf(row);
          const threshold = state === 'low' ? row.low_stock_threshold : row.critical_threshold;
          return (
            <li key={row.inventory_item_id}>
              <button
                type="button"
                aria-pressed={selected}
                data-need-item={row.inventory_item_id}
                onClick={() => onSelectNeed(row)}
                className={cn(
                  'flex w-full min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected && 'border-primary bg-primary/5',
                )}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{row.name}</span>
                  <StatusBadge status={stockBadgeStatus(state)} type="inventory" />
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                  <span className={cn(row.quantity_available <= 0 && 'font-medium text-destructive')}>
                    {row.quantity_available <= 0 ? 'Out of stock' : `${formatQuantity(row.quantity_available, row.base_unit_code)} available`}
                  </span>
                  {row.quantity_reserved > 0 && <span>{formatQuantity(row.quantity_reserved, row.base_unit_code)} reserved</span>}
                  {threshold !== null && (
                    <span>
                      {state === 'low' ? 'Low' : 'Critical'} at {threshold} {row.base_unit_code}
                    </span>
                  )}
                  <span>Unit: {row.base_unit_code}</span>
                </span>
                {row.recipe_shortage && (
                  <span className="text-xs text-muted-foreground" data-testid="need-shortage-detail">
                    {recipeShortageLine(row.quantity_available, row.recipe_shortage)}. Affects {affectedLabel(row.recipe_shortage)}.
                    {otherChoicesStillSell(row.recipe_shortage) && ' Other choices still sell.'}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="app-card-padding space-y-1 pb-3">
        <CardTitle className="text-base">1. Stock needs</CardTitle>
        <CardDescription>Out-of-stock, insufficient, critical and low items at the destination — the same list as Inventory › Needs attention.</CardDescription>
      </CardHeader>
      <CardContent className="app-card-padding space-y-4 pt-0">
        <div className="space-y-2">
          <Label htmlFor={selectId}>
            Destination branch<span className="ml-0.5 text-destructive">*</span>
          </Label>
          <Select value={destinationId} onValueChange={onDestinationChange} disabled={isBranchesLoading}>
            <SelectTrigger id={selectId} aria-label="Destination branch">
              <SelectValue placeholder={isBranchesLoading ? 'Loading branches…' : 'Select the branch that needs stock'} />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {body}
        {rows && needs.length > 0 && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {needs.length} of {rows.length} items need stock. Choose one to fill in the transfer form.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
