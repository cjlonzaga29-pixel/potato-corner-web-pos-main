'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { STATUTORY_DISCOUNT_PERCENT, isLawfulPwdRate } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSaveError, useDiscountPolicy, useUpdateDiscountPolicy } from '@/hooks/queries/use-settings';

function parsePercent(value: string, min: number): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= 100 && Math.round(n * 100) / 100 === n ? n : null;
}

/**
 * Task 209.xx — the organization-wide discount defaults (GET/PUT
 * /api/settings/discount-policy). Every branch uses these unless it has its
 * own value (POS-PERF-P50R, Discounts & VAT by branch).
 *
 * POS-PERF-P50R — only a Super Admin saves these (the server refuses
 * supervisors, whose changes used to reach every branch). PWD is editable
 * from 20% up (RA 10754: "at least 20%") and cannot be turned off; Senior
 * Citizen is exactly 20% (RA 9994) and read-only. 'promotional' is not shown:
 * custom discounts live on the Discounts & Promotions page.
 *
 * POS-PERF-P50 — every save carries the `updatedAt` this form loaded; if
 * someone else saved in between, the server refuses (SETTINGS_CHANGED) and
 * the form reloads their values instead of overwriting them.
 */
export function DiscountSettingsSection({ canEdit }: { canEdit: boolean }) {
  const { data: policy, isLoading: isFetching, isError } = useDiscountPolicy();
  // Idle (not yet run) counts as loading, so the card never renders empty.
  const isLoading = isFetching || (policy === undefined && !isError);
  const updatePolicy = useUpdateDiscountPolicy();

  const [employee, setEmployee] = useState({ percentage: '20', isEnabled: true });
  const [pwd, setPwd] = useState('20');
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!policy) return;
    setEmployee({ percentage: String(policy.employee.percentage), isEnabled: policy.employee.isEnabled });
    setPwd(String(policy.pwd.percentage));
  }, [policy]);

  const employeeValue = parsePercent(employee.percentage, 0);
  const pwdValue = parsePercent(pwd, STATUTORY_DISCOUNT_PERCENT);
  const isEmployeeInvalid = employeeValue === null;
  const isPwdInvalid = pwdValue === null && pwd !== String(policy?.pwd.percentage);
  const isDirty =
    policy !== undefined &&
    (employeeValue !== policy.employee.percentage || employee.isEnabled !== policy.employee.isEnabled || (pwdValue !== null && pwdValue !== policy.pwd.percentage));
  const statutoryMismatch = policy
    ? !isLawfulPwdRate(policy.pwd.percentage) || !policy.pwd.isEnabled || policy.senior_citizen.percentage !== STATUTORY_DISCOUNT_PERCENT || !policy.senior_citizen.isEnabled
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
    if (isEmployeeInvalid || isPwdInvalid || !policy) return;
    save({
      employee: { percentage: employeeValue, isEnabled: employee.isEnabled },
      ...(pwdValue !== null && pwdValue !== policy.pwd.percentage ? { pwd: { percentage: pwdValue } } : {}),
    });
  }

  function handleRestoreStatutory() {
    const statutory = { percentage: STATUTORY_DISCOUNT_PERCENT, isEnabled: true };
    save({ pwd: statutory, senior_citizen: statutory });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization discount defaults</CardTitle>
        <CardDescription>
          The rate each POS discount applies at every branch that has not set its own value. Cashiers never enter a percentage. Changes apply to new
          sales only; past sales keep the rate they were rung with.
          {!canEdit && ' Only a Super Admin changes these defaults; supervisors set values for their own branches below.'}
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
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3" data-testid="discount-row-senior_citizen">
                <div className="min-w-0">
                  <p className="font-medium">Senior Citizen</p>
                  <p className="text-xs text-muted-foreground">Set by law (RA 9994): exactly {STATUTORY_DISCOUNT_PERCENT}%, VAT-exempt. Cannot be changed or turned off.</p>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="font-semibold tabular-nums">{policy.senior_citizen.percentage}%</span>
                  <span className="text-xs text-muted-foreground">{policy.senior_citizen.isEnabled ? 'Enabled' : 'Disabled'}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-3" data-testid="discount-row-pwd">
                <div className="min-w-0">
                  <Label htmlFor="discount-pwd" className="font-medium">
                    PWD
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Required by law (RA 10754): at least {STATUTORY_DISCOUNT_PERCENT}%, VAT-exempt, always on. It can be raised, never lowered or turned off.
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {canEdit ? (
                    <Input
                      id="discount-pwd"
                      type="number"
                      min={STATUTORY_DISCOUNT_PERCENT}
                      max={100}
                      step="0.01"
                      className="w-20 text-right"
                      value={pwd}
                      aria-invalid={isPwdInvalid}
                      onChange={(e) => setPwd(e.target.value)}
                    />
                  ) : (
                    <span className="font-semibold tabular-nums">{policy.pwd.percentage}</span>
                  )}
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
              {isPwdInvalid && (
                <p className="text-xs text-destructive">
                  PWD must be {STATUTORY_DISCOUNT_PERCENT} to 100 (at most 2 decimals). The law does not allow less than {STATUTORY_DISCOUNT_PERCENT}%.
                </p>
              )}

              {statutoryMismatch && (
                <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <p>
                    A PWD or Senior Citizen value saved earlier is outside what the law requires ({STATUTORY_DISCOUNT_PERCENT}% for seniors, at least{' '}
                    {STATUTORY_DISCOUNT_PERCENT}% for PWD, always enabled), and checkout is using it.
                  </p>
                  {canEdit && (
                    <Button type="button" variant="outline" size="sm" onClick={handleRestoreStatutory} disabled={updatePolicy.isPending}>
                      Restore {STATUTORY_DISCOUNT_PERCENT}% for PWD and Senior Citizen
                    </Button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-3" data-testid="discount-row-employee">
                <div className="min-w-0">
                  <Label htmlFor="discount-employee" className="font-medium">
                    Employee
                  </Label>
                  <p className="text-xs text-muted-foreground">Business choice. Comes off the VAT-inclusive price; VAT is charged on the rest.</p>
                </div>
                {canEdit ? (
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
                ) : (
                  <span className="text-sm font-semibold tabular-nums">
                    {policy.employee.percentage}% <span className="text-xs font-normal text-muted-foreground">{policy.employee.isEnabled ? 'Enabled' : 'Disabled'}</span>
                  </span>
                )}
              </div>
            </div>

            {canEdit && isEmployeeInvalid && <p className="text-xs text-destructive">The Employee percentage must be a number between 0 and 100.</p>}
            {conflict && (
              <p role="alert" className="text-sm text-destructive" data-testid="discount-settings-conflict">
                Someone else changed these settings after you opened them. The current values are shown now — check them, then make your change again.
              </p>
            )}

            {policy.updatedAt && <p className="text-xs text-muted-foreground">Last updated {new Date(policy.updatedAt).toLocaleString()}</p>}

            {canEdit && (
              <Button onClick={handleSave} disabled={updatePolicy.isPending || isEmployeeInvalid || isPwdInvalid || !isDirty}>
                {updatePolicy.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
