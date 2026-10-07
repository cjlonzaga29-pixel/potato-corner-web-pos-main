'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface OrderStatusStripProps {
  savingCount: number;
  needsAttentionCount: number;
  /** Every tracked detached order, including already-confirmed ones still retained for "View Receipt" (see lib/detached-sales.ts pruneConfirmedDetachedSales). */
  totalCount: number;
  onOpenDetails: () => void;
}

/**
 * POS-PERF-P21 — a compact, persistent summary of every order the cashier
 * has moved on from via "Next Customer" (lib/detached-sales.ts), always
 * visible once at least one exists so "where did my earlier order go" never
 * requires remembering to check anything. Deliberately text + color, not
 * icon-only, so the state reads correctly even for a cashier who hasn't
 * learned the icon meanings yet. Opening details (the existing
 * PendingSalesPanel, labeled "Orders") is an explicit, optional action from
 * here — this strip itself already answers "is anything saving or stuck"
 * without it.
 */
export function OrderStatusStrip({ savingCount, needsAttentionCount, totalCount, onOpenDetails }: OrderStatusStripProps) {
  if (totalCount === 0) return null;

  const hasAttention = needsAttentionCount > 0;

  return (
    <Button
      variant={hasAttention || savingCount > 0 ? 'outline' : 'ghost'}
      size="sm"
      className={`touch-target gap-2 ${hasAttention ? 'border-destructive text-destructive' : savingCount > 0 ? 'border-warning text-warning-foreground' : ''}`}
      onClick={onOpenDetails}
    >
      {/* POS-PERF-P22 — "Orders" (renamed from "Pending Sales") stays the
          button's own label (not folded into aria-label) — it is also the
          PendingSalesPanel's own dialog title, and keeping the two in sync
          is what lets a cashier (or a test) find "the thing that opens
          Orders" by that exact name. */}
      Orders
      {savingCount > 0 && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {savingCount} saving
        </span>
      )}
      {hasAttention && (
        <span className="flex items-center gap-1 font-medium text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {needsAttentionCount} needs attention
        </span>
      )}
      <Badge variant={hasAttention ? 'destructive' : savingCount > 0 ? 'warning' : 'outline'}>{totalCount}</Badge>
    </Button>
  );
}
