'use client';

import { useState } from 'react';
import { Package, Pencil, Plus, Power } from 'lucide-react';
import type { ExtraSupplyResponse } from '@potato-corner/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useExtraSupplies, useSetExtraSupplyActive } from '@/hooks/queries/use-extra-supplies';
import { useBranchStore } from '@/stores/branch.store';
import { formatCurrency } from '@/lib/utils';
import { ExtraSupplyFormDialog } from './extra-supply-form-dialog';

/** POS-PERF-P61 — Supervisor -> Extra Supplies: Create Supply, Edit, Deactivate and Reactivate. */
export function ExtraSuppliesSetup() {
  const activeBranchId = useBranchStore((state) => state.activeBranchId);
  const supplies = useExtraSupplies();
  const setActive = useSetExtraSupplyActive();
  const [editing, setEditing] = useState<ExtraSupplyResponse | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(supply: ExtraSupplyResponse) {
    setError(null);
    try {
      await setActive.mutateAsync({ id: supply.id, isActive: !supply.is_active, expectedVersion: supply.version });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That change could not be saved.');
    }
  }

  return (
    <div className="space-y-4" data-testid="extra-supplies-setup">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">Cards cashiers use for additional cups, tissue and bags. Deactivating a card removes it from new entry and keeps its history.</p>
        <Button onClick={() => setEditing('new')} className="gap-2" data-testid="supply-create">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create Supply
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {supplies.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{supplies.error.message}</AlertDescription>
        </Alert>
      )}
      {supplies.isLoading && <p className="text-sm text-muted-foreground">Loading supplies…</p>}
      {supplies.data?.length === 0 && <EmptyState title="No supplies yet" description="Create a card for each additional item a cashier may give or sell." />}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {supplies.data?.map((supply) => (
          <li key={supply.id} className="flex gap-3 rounded-md border bg-card p-3" data-testid="supply-row">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
              {supply.image_url ? <img src={supply.image_url} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Package className="h-7 w-7 text-muted-foreground" aria-hidden="true" />}
            </div>
            <div className="min-w-0 flex-1 space-y-1 text-sm">
              <p className="flex flex-wrap items-center gap-1 font-medium">
                <span className="[overflow-wrap:anywhere]">{supply.name}</span>
                {!supply.is_active && <Badge variant="inactive">Deactivated</Badge>}
                {supply.is_active && !supply.apply_to_pos && <Badge variant="secondary">Not on POS</Badge>}
              </p>
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                1 {supply.issue_unit_name} = {supply.base_quantity} {supply.base_unit_code} of {supply.inventory_item_name}
              </p>
              <p className="text-muted-foreground">
                {supply.selling_price !== null ? `${formatCurrency(supply.selling_price)} if paid` : 'Free only'}
                {supply.configured_issue_cost !== null && ` · stated cost ${formatCurrency(supply.configured_issue_cost)}`}
              </p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {supply.branches.map((b) => b.branch_name).join(', ')}
                {supply.other_branch_count > 0 && ` and ${supply.other_branch_count} other ${supply.other_branch_count === 1 ? 'branch' : 'branches'}`}
                {' · '}
                {supply.issue_count} {supply.issue_count === 1 ? 'line' : 'lines'} issued
              </p>
              {!supply.inventory_item_available && <p className="text-xs font-medium text-destructive">Its inventory item changed. Edit this card before it can be issued.</p>}
              {supply.can_manage ? (
                <div className="flex flex-wrap gap-1 pt-1">
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => setEditing(supply)} aria-label={`Edit ${supply.name}`}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => void toggle(supply)} disabled={setActive.isPending} aria-label={`${supply.is_active ? 'Deactivate' : 'Reactivate'} ${supply.name}`}>
                    <Power className="h-3.5 w-3.5" aria-hidden="true" />
                    {supply.is_active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Shared with a branch outside your assignment, so it can&apos;t be changed here.</p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editing && <ExtraSupplyFormDialog supply={editing === 'new' ? null : editing} defaultBranchId={activeBranchId} onOpenChange={(open) => !open && setEditing(null)} onSaved={() => setEditing(null)} />}
    </div>
  );
}
