'use client';

import { useEffect, useState } from 'react';
import type { BranchDiscountSettingsResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SettingsSaveError, useUpdateBranchDiscountSettings } from '@/hooks/queries/use-settings';
import { formatManilaDateTime } from '@/lib/manila-date';

/**
 * POS-PERF-P50R — one branch's discount decision setting. POS-PERF-P63 — VAT
 * is retired, so the statutory PWD/Senior and Employee rate editors are gone:
 * no new sale uses those rates. Their stored values are re-sent unchanged on
 * save (never reset), so history and the stored record stay as they are.
 * Saves carry the version this form loaded, so a newer save is never overwritten.
 */
export function BranchDiscountSettingsForm({ data }: { data: BranchDiscountSettingsResponse }) {
  const save = useUpdateBranchDiscountSettings(data.branchId);
  const initial = data.override?.requireDiscountChoice ?? false;
  const [requireDiscountChoice, setRequireDiscountChoice] = useState(initial);
  const [conflict, setConflict] = useState(false);

  useEffect(() => setRequireDiscountChoice(data.override?.requireDiscountChoice ?? false), [data]);

  const dirty = requireDiscountChoice !== initial;
  const disabled = !data.canEdit;
  const id = (name: string) => `${name}-${data.branchId}`;

  function handleSave() {
    setConflict(false);
    save.mutate(
      {
        pwdPercentage: data.override?.pwdPercentage ?? null,
        employee: data.override?.employee ?? null,
        requireDiscountChoice,
        expectedUpdatedAt: data.updatedAt,
      },
      { onError: (error) => setConflict(error instanceof SettingsSaveError && error.code === 'SETTINGS_CHANGED') },
    );
  }

  return (
    <div className="space-y-4" data-testid={`branch-discount-form-${data.branchId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3" data-testid="branch-row-require-choice">
        <div className="min-w-0 max-w-prose">
          <Label htmlFor={id('require-choice')} className="font-medium">
            Cashier must choose a discount
          </Label>
          <p className="text-xs text-muted-foreground">
            Before charging, the cashier picks &ldquo;No discount&rdquo; or one of this branch&apos;s discount types; nothing is preselected. Nothing is
            applied automatically. Every sale is subtotal − discount = amount to pay.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={id('require-choice')} checked={requireDiscountChoice} disabled={disabled} onCheckedChange={setRequireDiscountChoice} />
          <span className="text-xs text-muted-foreground">{requireDiscountChoice ? 'Required' : 'Optional'}</span>
        </div>
      </div>

      {conflict && (
        <p role="alert" className="text-sm text-destructive" data-testid="branch-discount-conflict">
          Someone else changed {data.branchName}&apos;s discounts after you opened them. The current values are shown now — check them, then make your change
          again.
        </p>
      )}
      {data.updatedAt && <p className="text-xs text-muted-foreground">Last changed for this branch {formatManilaDateTime(data.updatedAt)}</p>}

      {data.canEdit ? (
        <Button onClick={handleSave} disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : `Save for ${data.branchName}`}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">You can view these settings but not change them.</p>
      )}
    </div>
  );
}
