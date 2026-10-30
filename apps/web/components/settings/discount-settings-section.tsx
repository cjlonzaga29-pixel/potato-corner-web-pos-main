'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { STATUTORY_DISCOUNT_PERCENT } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSaveError, useDiscountPolicy, useUpdateDiscountPolicy } from '@/hooks/queries/use-settings';

/**
 * POS-PERF-P50 — PWD and Senior Citizen are set by law (20%, VAT-exempt;
 * RA 10754 / RA 9994) and shown read-only; the server refuses any change to
 * them (STATUTORY_DISCOUNT_LOCKED). Only the Employee rate is a business
 * choice and editable here.
 *
 * 'promotional' is intentionally excluded: product promotions are configured
 * per product on the Promotions page, and the old typed whole-cart
 * "Promotional" amount is refused at checkout.
 */
const STATUTORY_ROWS = [
  { type: 'pwd', label: 'PWD', law: 'RA 10754' },
  { type: 'senior_citizen', label: 'Senior Citizen', law: 'RA 9994' },
] as const;

/**
 * Task 209.xx — the ONE place the existing POS discount percentages are
 * configured: database-backed (GET/PUT /api/settings/discount-policy) and
 * server-authoritative — the POS dropdown, the checkout calculation,
 * receipts and reports all read the same setting. Shared between the
 * Supervisor and Admin settings pages (adminOrSupervisor on the PUT route).
 *
 * POS-PERF-P50 — every save carries the `updatedAt` this form loaded; if
 * someone else saved in between, the server refuses (SETTINGS_CHANGED) and
 * the form reloads their values instead of overwriting them.
 */
export function DiscountSettingsSection() {
  const { data: policy, isLoading: isFetching, isError } = useDiscountPolicy();
  // Idle (not yet run) counts as loading, so the card never renders empty.
  const isLoading = isFetching || (policy === undefined && !isError);
  const updatePolicy = useUpdateDiscountPolicy();

  const [employee, setEmployee] = useState({ percentage: '20', isEnabled: true });
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!policy) return;
    setEmployee({ percentage: String(policy.employee.percentage), isEnabled: policy.employee.isEnabled });
  }, [policy]);

  const employeeValue = Number(employee.percentage);
  const isEmployeeInvalid = employee.percentage.trim() === '' || !Number.isFinite(employeeValue) || employeeValue < 0 || employeeValue > 100;
  const isDirty = policy !== undefined && (employeeValue !== policy.employee.percentage || employee.isEnabled !== policy.employee.isEnabled);
  const statutoryMismatch = policy
    ? STATUTORY_ROWS.some(({ type }) => policy[type].percentage !== STATUTORY_DISCOUNT_PERCENT || !policy[type].isEnabled)
    : false;

  function save(input: Parameters<typeof updatePolicy.mutate>[0]) {
    setConflict(false);
    updatePolicy.mutate(
      { ...input, expectedUpdatedAt: policy?.updatedAt ?? null },
      {
        onError: (error) => {
          if (error instanceof SettingsSaveError && error.code === 'SETTINGS_CHANGED') setConflict(true);
        },
      },
    );
  }

  function handleSave() {
    if (isEmployeeInvalid) return;
    save({ employee: { percentage: employeeValue, isEnabled: employee.isEnabled } });
  }

  function handleRestoreStatutory() {
    const statutory = { percentage: STATUTORY_DISCOUNT_PERCENT, isEnabled: true };
    save({ pwd: statutory, senior_citizen: statutory });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discount Settings</CardTitle>
        <CardDescription>
          The percentage each POS discount applies at checkout, for every branch. Cashiers never enter a percentage — the POS always
          shows and charges what is saved here. Changes apply to new sales only; past sales keep the rate they were rung with.
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

        {!isLoading && !isError && policy && (
          <>
            <div className="space-y-3">
              {STATUTORY_ROWS.map(({ type, label, law }) => (
                <div key={type} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3" data-testid={`discount-row-${type}`}>
                  <div className="min-w-0">
                    <p className="font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">Set by law ({law}): VAT-exempt. Cannot be changed or turned off.</p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="font-semibold tabular-nums">{policy[type].percentage}%</span>
                    <span className="text-xs text-muted-foreground">{policy[type].isEnabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                </div>
              ))}

              {statutoryMismatch && (
                <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <p>
                    A PWD or Senior Citizen value saved earlier is not the {STATUTORY_DISCOUNT_PERCENT}% (enabled) required by law, and checkout
                    is using it.
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={handleRestoreStatutory} disabled={updatePolicy.isPending}>
                    Restore {STATUTORY_DISCOUNT_PERCENT}% for PWD and Senior Citizen
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-3" data-testid="discount-row-employee">
                <div className="min-w-0">
                  <Label htmlFor="discount-employee" className="font-medium">
                    Employee
                  </Label>
                  <p className="text-xs text-muted-foreground">Business choice. Comes off the VAT-inclusive price.</p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="discount-employee-enabled"
                      checked={employee.isEnabled}
                      onCheckedChange={(checked) => setEmployee((prev) => ({ ...prev, isEnabled: checked }))}
                      aria-label="Employee discount enabled"
                    />
                    <span className="text-xs text-muted-foreground">{employee.isEnabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Input
                      id="discount-employee"
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      className="w-20 text-right"
                      value={employee.percentage}
                      onChange={(e) => setEmployee((prev) => ({ ...prev, percentage: e.target.value }))}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
              </div>
            </div>

            {isEmployeeInvalid && <p className="text-xs text-destructive">The percentage must be a number between 0 and 100.</p>}
            {conflict && (
              <p role="alert" className="text-sm text-destructive" data-testid="discount-settings-conflict">
                Someone else changed these settings after you opened them. The current values are shown now — check them, then make your
                change again.
              </p>
            )}

            {policy.updatedAt && <p className="text-xs text-muted-foreground">Last updated {new Date(policy.updatedAt).toLocaleString()}</p>}

            <Button onClick={handleSave} disabled={updatePolicy.isPending || isEmployeeInvalid || !isDirty}>
              {updatePolicy.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
