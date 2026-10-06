'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useWriteGate, useUpdateWriteGate } from '@/hooks/queries/use-settings';

/**
 * POS-PERF-P17 — minimal Super Admin control surface for the POS-PERF-P16
 * operational write gate (middleware/write-gate.ts). Closing this blocks
 * every checkout and inventory-mutating write in production with a 503
 * until reopened — route-level access to this page is already Super-Admin
 * only (middleware.ts gates the whole (admin) route group), so no
 * additional role check is needed here; the PUT route's own adminOnly
 * guard is the actual enforcement boundary regardless.
 */
export function WriteGateSettingsSection() {
  const { data: gate, isLoading, isError } = useWriteGate();
  const updateGate = useUpdateWriteGate();

  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const trimmedReason = reason.trim();

  function handleClose() {
    if (!trimmedReason) return;
    updateGate.mutate(
      { enabled: true, reason: trimmedReason },
      { onSuccess: () => setReason('') },
    );
  }

  function handleReopen() {
    updateGate.mutate({ enabled: false });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Operational Write Gate</CardTitle>
        <CardDescription>
          Blocks checkout and inventory writes with a 503 across every instance, for a safe deploy swap or rollback. Read-only
          traffic (dashboards, reports) is never affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-24 w-full" />}

        {isError && <p className="text-sm text-destructive">Failed to load write-gate state.</p>}

        {!isLoading && !isError && gate && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Status</span>
                  <Badge variant={gate.enabled ? 'critical' : 'active'}>{gate.enabled ? 'Closed' : 'Open'}</Badge>
                </div>
                {gate.enabled && gate.reason && <p className="text-sm text-muted-foreground">Reason: {gate.reason}</p>}
                {gate.updatedAt && (
                  <p className="text-xs text-muted-foreground">
                    Last changed {new Date(gate.updatedAt).toLocaleString()}
                    {gate.updatedBy ? ` by ${gate.updatedBy}` : ''}
                  </p>
                )}
              </div>
              <div className="space-y-1 text-right">
                <p className="text-2xl font-semibold tabular-nums">{gate.activeGatedRequests}</p>
                <p className="text-xs text-muted-foreground">active gated requests</p>
              </div>
            </div>

            {!gate.enabled && (
              <div className="space-y-2">
                <Label htmlFor="write-gate-reason">Reason (required to close)</Label>
                <Textarea
                  id="write-gate-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. P18 release deploy"
                  maxLength={500}
                  disabled={updateGate.isPending}
                />
                <Button
                  variant="danger"
                  disabled={!trimmedReason || updateGate.isPending}
                  onClick={() => setConfirmOpen(true)}
                >
                  Close Gate
                </Button>
              </div>
            )}

            {gate.enabled && (
              <Button onClick={handleReopen} disabled={updateGate.isPending}>
                {updateGate.isPending ? 'Reopening...' : 'Reopen Gate'}
              </Button>
            )}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Close the write gate?"
        description={`Checkout and inventory writes will return 503 until this is reopened. Reason: "${trimmedReason}"`}
        confirmLabel="Close Gate"
        variant="danger"
        onConfirm={handleClose}
      />
    </Card>
  );
}
