'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDiscountPolicy, useUpdateDiscountPolicy } from '@/hooks/queries/use-settings';
import type { ConfigurableDiscountType } from '@potato-corner/shared';

/**
 * 'promotional' is intentionally excluded here: it exists in the shared
 * discount-policy schema for forward compatibility, but the POS checkout
 * does not support a Promotional discount flow yet (createTransaction still
 * rejects it as DISCOUNT_TYPE_NOT_SUPPORTED). Exposing a working-looking
 * toggle/percentage for a type that does nothing at checkout would mislead
 * Supervisor/Admin users, so it stays hidden from this form until runtime
 * support for Promotional checkout exists.
 */
const ROWS: { type: ConfigurableDiscountType; label: string }[] = [
  { type: 'pwd', label: 'PWD' },
  { type: 'senior_citizen', label: 'Senior Citizen' },
  { type: 'employee', label: 'Employee' },
];

type FormState = Record<ConfigurableDiscountType, { percentage: string; isEnabled: boolean }>;

const EMPTY_FORM: FormState = {
  pwd: { percentage: '20', isEnabled: true },
  senior_citizen: { percentage: '20', isEnabled: true },
  employee: { percentage: '20', isEnabled: true },
  promotional: { percentage: '20', isEnabled: true },
};

/**
 * Task 209.xx — the ONE place the existing PWD/Senior Citizen/Employee/
 * Promotional discount percentages are configured. This does not add a new
 * discount type or a new discount engine — it only makes the percentage
 * those existing POS discount types apply centrally configurable, database-
 * backed (GET/PUT /api/settings/discount-policy), and server-authoritative:
 * the POS dropdown, the checkout calculation, receipts, and reports all
 * read from the same setting this form writes to. Shared between the
 * Supervisor and Admin settings pages — both roles may save changes here
 * (adminOrSupervisor on the PUT route); Cashier/Staff and Branch Account
 * never reach this component at all (no settings page exists in their
 * route groups).
 */
export function DiscountSettingsSection() {
  const { data: policy, isLoading, isError } = useDiscountPolicy();
  const updatePolicy = useUpdateDiscountPolicy();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (!policy) return;
    setForm({
      pwd: { percentage: String(policy.pwd.percentage), isEnabled: policy.pwd.isEnabled },
      senior_citizen: { percentage: String(policy.senior_citizen.percentage), isEnabled: policy.senior_citizen.isEnabled },
      employee: { percentage: String(policy.employee.percentage), isEnabled: policy.employee.isEnabled },
      promotional: { percentage: String(policy.promotional.percentage), isEnabled: policy.promotional.isEnabled },
    });
  }, [policy]);

  function setRow(type: ConfigurableDiscountType, patch: Partial<FormState[ConfigurableDiscountType]>) {
    setForm((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));
  }

  function handleSave() {
    const payload: Record<string, { percentage: number; isEnabled: boolean }> = {};
    for (const { type } of ROWS) {
      const percentage = Number(form[type].percentage);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return;
      payload[type] = { percentage, isEnabled: form[type].isEnabled };
    }
    updatePolicy.mutate(payload);
  }

  const hasInvalidRow = ROWS.some(({ type }) => {
    const value = Number(form[type].percentage);
    return form[type].percentage.trim() === '' || !Number.isFinite(value) || value < 0 || value > 100;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discount Settings</CardTitle>
        <CardDescription>
          The percentage each POS discount type applies at checkout. Cashiers never enter a percentage — the POS always shows and
          charges whatever is saved here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {isError && <p className="text-sm text-destructive">Failed to load discount settings.</p>}

        {!isLoading && !isError && (
          <>
            <div className="space-y-3">
              {ROWS.map(({ type, label }) => (
                <div key={type} className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="min-w-0">
                    <Label htmlFor={`discount-${type}`} className="font-medium">
                      {label}
                    </Label>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`discount-${type}-enabled`}
                        checked={form[type].isEnabled}
                        onCheckedChange={(checked) => setRow(type, { isEnabled: checked })}
                        aria-label={`${label} enabled`}
                      />
                      <span className="text-xs text-muted-foreground">{form[type].isEnabled ? 'Enabled' : 'Disabled'}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        id={`discount-${type}`}
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        className="w-20 text-right"
                        value={form[type].percentage}
                        onChange={(e) => setRow(type, { percentage: e.target.value })}
                      />
                      <span className="text-sm text-muted-foreground">%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {hasInvalidRow && <p className="text-xs text-destructive">Each percentage must be a number between 0 and 100.</p>}

            {policy?.updatedAt && (
              <p className="text-xs text-muted-foreground">Last updated {new Date(policy.updatedAt).toLocaleString()}</p>
            )}

            <Button onClick={handleSave} disabled={updatePolicy.isPending || hasInvalidRow}>
              {updatePolicy.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
