'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import { usePaymentMethodConfig, useUpdatePaymentMethodConfig } from '@/hooks/queries/use-settings';
import { useAuthStore } from '@/stores/auth.store';

interface FormState {
  cashEnabled: boolean;
  gcashEnabled: boolean;
}

const EMPTY_FORM: FormState = { cashEnabled: true, gcashEnabled: true };

/** UX nicety on top of the server's 422 PAYMENT_METHOD_ALL_DISABLED guard: never let the last enabled method be switched off client-side. */
const LAST_METHOD_TOOLTIP = 'At least one payment method must stay enabled';

export function PaymentMethodsSection() {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const [branchId, setBranchId] = useState<string | null>(null);
  const { data: branchesData } = useBranches({ limit: 100 });
  const { data: config, isLoading, isError } = usePaymentMethodConfig(branchId);
  const updateConfig = useUpdatePaymentMethodConfig(branchId ?? '');

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    setForm(config ? { cashEnabled: config.cashEnabled, gcashEnabled: config.gcashEnabled } : EMPTY_FORM);
  }, [config, branchId]);

  function handleSave() {
    if (!branchId) return;
    updateConfig.mutate({ cashEnabled: form.cashEnabled, gcashEnabled: form.gcashEnabled });
  }

  const cashIsLastEnabled = form.cashEnabled && !form.gcashEnabled;
  const gcashIsLastEnabled = form.gcashEnabled && !form.cashEnabled;

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Payment Methods</CardTitle>
          <CardDescription>Per-branch cash and GCash acceptance configuration.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Only Super Admins can configure payment methods.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Methods</CardTitle>
        <CardDescription>Per-branch cash and GCash acceptance configuration.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="branchId">Branch</Label>
          <Select value={branchId ?? undefined} onValueChange={setBranchId}>
            <SelectTrigger id="branchId">
              <SelectValue placeholder="Select a branch" />
            </SelectTrigger>
            <SelectContent>
              {(branchesData?.branches ?? []).map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!branchId && <p className="text-sm text-muted-foreground">Select a branch to configure its payment methods.</p>}

        {branchId && isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {branchId && isError && <p className="text-sm text-destructive">Failed to load payment method configuration.</p>}

        {branchId && !isLoading && !isError && (
          <div className="max-w-md space-y-4">
            <div
              className="flex items-center justify-between rounded-md border p-3"
              title={cashIsLastEnabled ? LAST_METHOD_TOOLTIP : undefined}
            >
              <div>
                <Label htmlFor="cashEnabled">Cash</Label>
                <p className="text-xs text-muted-foreground">Accept cash payments at this branch.</p>
              </div>
              <Switch
                id="cashEnabled"
                checked={form.cashEnabled}
                disabled={cashIsLastEnabled}
                onCheckedChange={(checked) => {
                  if (!checked && cashIsLastEnabled) return;
                  setForm({ ...form, cashEnabled: checked });
                }}
              />
            </div>

            <div
              className="flex items-center justify-between rounded-md border p-3"
              title={gcashIsLastEnabled ? LAST_METHOD_TOOLTIP : undefined}
            >
              <div>
                <Label htmlFor="gcashEnabled">GCash</Label>
                <p className="text-xs text-muted-foreground">Accept GCash payments at this branch.</p>
              </div>
              <Switch
                id="gcashEnabled"
                checked={form.gcashEnabled}
                disabled={gcashIsLastEnabled}
                onCheckedChange={(checked) => {
                  if (!checked && gcashIsLastEnabled) return;
                  setForm({ ...form, gcashEnabled: checked });
                }}
              />
            </div>

            <Button onClick={handleSave} disabled={updateConfig.isPending}>
              {updateConfig.isPending ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
