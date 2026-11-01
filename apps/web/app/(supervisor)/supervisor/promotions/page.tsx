'use client';

import { useMemo, useState } from 'react';
import { Pencil, Plus, Power, TicketPercent } from 'lucide-react';
import { toast } from 'sonner';
import type { PromotionResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { PromotionEditorDialog } from '@/components/supervisor/promotions/promotion-editor-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useBranches } from '@/hooks/queries/use-branches';
import { isPromotionsUnsupported, usePromotions, useSetPromotionEnabled } from '@/hooks/queries/use-promotions';
import { formatCurrency, formatDate } from '@/lib/utils';

const STATE_LABELS: Record<PromotionResponse['schedule_state'], { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  active: { label: 'Active now', variant: 'default' },
  scheduled: { label: 'Scheduled', variant: 'secondary' },
  expired: { label: 'Ended', variant: 'outline' },
  disabled: { label: 'Disabled', variant: 'outline' },
};

function describeDiscount(promotion: PromotionResponse): string {
  return promotion.discount_kind === 'percentage'
    ? `${promotion.discount_value}% off each item`
    : `${formatCurrency(promotion.discount_value)} off each item`;
}

function describeDates(promotion: PromotionResponse): string {
  if (!promotion.starts_on && !promotion.ends_on) return 'No date limit';
  // Date-only strings are Manila business days; format them at noon UTC so no timezone can shift the day.
  const day = (value: string) => formatDate(new Date(`${value}T12:00:00Z`));
  if (promotion.starts_on && promotion.ends_on) return `${day(promotion.starts_on)} – ${day(promotion.ends_on)}`;
  return promotion.starts_on ? `From ${day(promotion.starts_on)}` : `Until ${day(promotion.ends_on as string)}`;
}

/**
 * POS-PERF-P49 — product promotions for the branches this supervisor manages.
 * A promotion that also covers another supervisor's branch is shown read-only
 * with the reason; the API enforces the same rule on every write.
 */
export default function SupervisorPromotionsPage() {
  const { user } = useAuth();
  const { data, isLoading, isError, error, refetch } = usePromotions();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const setEnabled = useSetPromotionEnabled();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PromotionResponse | null>(null);
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);

  const myBranches = useMemo(() => {
    const mine = user?.branchIds ?? [];
    return (branchData?.branches ?? [])
      .filter((b) => mine.includes(b.id))
      .map((b) => ({ id: b.id, name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [branchData, user?.branchIds]);

  async function toggle(promotion: PromotionResponse) {
    if (pendingToggleId) return;
    setPendingToggleId(promotion.id);
    try {
      await setEnabled.mutateAsync({ promotionId: promotion.id, is_enabled: !promotion.is_enabled, expected_version: promotion.version });
      toast.success(promotion.is_enabled ? `${promotion.name} disabled` : `${promotion.name} enabled`);
    } catch (toggleError) {
      toast.error(toggleError instanceof Error ? toggleError.message : 'Failed to change the promotion');
      void refetch();
    } finally {
      setPendingToggleId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Discounts &amp; Promotions</h1>
          <p className="text-sm text-muted-foreground">
            Automatic promotions and cashier-selected discounts at your branches. Checkout always applies the current setting; past sales keep
            the discount they were charged. PWD, Senior Citizen and Employee rates are in Settings.
          </p>
          {/* POS-PERF-P55 — cutover notice: the current POS no longer applies these. */}
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="promotions-legacy-notice">
            The current POS checkout no longer applies promotions. Cashiers apply discounts as a peso amount using the discount types in Settings.
            Promotions here only affect terminals still running an older version; turn them off once every terminal is updated. Nothing here is
            deleted.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          // The editor needs the branch list; opening it early would show "no branches" and skip the single-branch preselect.
          disabled={isPromotionsUnsupported(error) || branchesLoading}
        >
          <Plus className="mr-2 h-4 w-4" />
          New discount
        </Button>
      </div>

      {isLoading && <LoadingSpinner />}
      {isError && isPromotionsUnsupported(error) && (
        <EmptyState
          icon={TicketPercent}
          title="Promotions are not available yet"
          description="The server has not been updated with promotions. Nothing here affects checkout until it is."
        />
      )}
      {isError && !isPromotionsUnsupported(error) && <ErrorState description={error.message} retry={() => void refetch()} />}
      {data && data.length === 0 && (
        <EmptyState
          icon={TicketPercent}
          title="No discounts yet"
          description="Create a cashier-selected discount for any product, or classify a product as Promotional or Seasonal for an automatic promotion."
        />
      )}

      {data && data.length > 0 && (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Promotions">
          {data.map((promotion) => {
            const state = STATE_LABELS[promotion.schedule_state];
            return (
              <li key={promotion.id}>
                <Card>
                  <CardContent className="space-y-3 pt-6">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="truncate font-medium">{promotion.name}</h2>
                        <p className="text-sm">{describeDiscount(promotion)}</p>
                        <p className="text-xs text-muted-foreground">
                          {promotion.application_mode === 'cashier_selected' ? 'Cashier selects at checkout' : 'Automatic promotion'}
                        </p>
                      </div>
                      <Badge variant={state.variant}>{state.label}</Badge>
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Products</dt>
                      <dd>{promotion.products.map((p) => p.name).join(', ')}</dd>
                      <dt className="text-muted-foreground">Branches</dt>
                      <dd>{promotion.branches.map((b) => b.name).join(', ')}</dd>
                      <dt className="text-muted-foreground">Dates</dt>
                      <dd>{describeDates(promotion)}</dd>
                    </dl>
                    {promotion.can_edit ? (
                      <div className="flex flex-wrap gap-2 border-t pt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={branchesLoading}
                          onClick={() => {
                            setEditing(promotion);
                            setEditorOpen(true);
                          }}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" disabled={pendingToggleId === promotion.id} onClick={() => void toggle(promotion)}>
                          <Power className="mr-2 h-4 w-4" />
                          {promotion.is_enabled ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    ) : (
                      <p className="border-t pt-3 text-xs text-muted-foreground">Read-only: {promotion.read_only_reason}</p>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <PromotionEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        promotion={editing}
        allPromotions={data ?? []}
        branches={myBranches}
      />
    </div>
  );
}
