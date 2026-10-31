'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { STATUTORY_DISCOUNT_PERCENT, type BranchDiscountSettingsResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SettingsSaveError, useUpdateBranchDiscountSettings } from '@/hooks/queries/use-settings';
import { formatManilaDateTime } from '@/lib/manila-date';
import { DiscountPreviewTable } from './discount-preview-table';
import { BranchVatRegistration } from './branch-vat-registration';

const SOURCE_LABELS = { statute: 'Set by law', organization: 'Organization default', branch: 'This branch' } as const;

interface FormState {
  pwdInherit: boolean;
  pwd: string;
  employeeInherit: boolean;
  employee: string;
  employeeEnabled: boolean;
  requireDiscountChoice: boolean;
}

function fromData(data: BranchDiscountSettingsResponse): FormState {
  return {
    pwdInherit: data.override?.pwdPercentage == null,
    pwd: String(data.override?.pwdPercentage ?? data.organization.pwd.percentage),
    employeeInherit: data.override?.employee == null,
    employee: String(data.override?.employee?.percentage ?? data.organization.employee.percentage),
    employeeEnabled: data.override?.employee?.isEnabled ?? data.organization.employee.isEnabled,
    requireDiscountChoice: data.override?.requireDiscountChoice ?? false,
  };
}

function parsePercent(value: string, min: number): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= 100 && Math.round(n * 100) / 100 === n ? n : null;
}

/**
 * POS-PERF-P50R — one branch's discount settings. Each rate either follows
 * the organization default or is set for this branch only; saving changes
 * nothing at any other branch. PWD can be raised (RA 10754: "at least 20%")
 * but never lowered or turned off; Senior Citizen is exactly 20% (RA 9994)
 * and not editable. Saves carry the version this form loaded, so a newer
 * save is never overwritten.
 */
export function BranchDiscountSettingsForm({ data, statutoryOnly = false }: { data: BranchDiscountSettingsResponse; statutoryOnly?: boolean }) {
  const save = useUpdateBranchDiscountSettings(data.branchId);
  const [form, setForm] = useState<FormState>(() => fromData(data));
  const [conflict, setConflict] = useState(false);

  useEffect(() => setForm(fromData(data)), [data]);

  const pwdValue = form.pwdInherit ? data.organization.pwd.percentage : parsePercent(form.pwd, STATUTORY_DISCOUNT_PERCENT);
  const employeeValue = form.employeeInherit ? data.organization.employee.percentage : parsePercent(form.employee, 0);
  const employeeEnabled = form.employeeInherit ? data.organization.employee.isEnabled : form.employeeEnabled;
  const pwdInvalid = !form.pwdInherit && pwdValue === null;
  const employeeInvalid = !form.employeeInherit && employeeValue === null;
  const initial = fromData(data);
  const dirty =
    form.pwdInherit !== initial.pwdInherit ||
    (!form.pwdInherit && pwdValue !== Number(initial.pwd)) ||
    form.employeeInherit !== initial.employeeInherit ||
    (!form.employeeInherit && (employeeValue !== Number(initial.employee) || form.employeeEnabled !== initial.employeeEnabled)) ||
    form.requireDiscountChoice !== initial.requireDiscountChoice;
  const disabled = !data.canEdit;
  const id = (name: string) => `${name}-${data.branchId}`;

  function handleSave() {
    if (pwdInvalid || employeeInvalid || pwdValue === null || employeeValue === null) return;
    setConflict(false);
    save.mutate(
      {
        pwdPercentage: form.pwdInherit ? null : pwdValue,
        employee: form.employeeInherit ? null : { percentage: employeeValue, isEnabled: form.employeeEnabled },
        requireDiscountChoice: form.requireDiscountChoice,
        expectedUpdatedAt: data.updatedAt,
      },
      { onError: (error) => setConflict(error instanceof SettingsSaveError && error.code === 'SETTINGS_CHANGED') },
    );
  }

  return (
    <div className="space-y-4" data-testid={`branch-discount-form-${data.branchId}`}>
      <BranchVatRegistration branchId={data.branchId} branchName={data.branchName} profile={data.taxProfile} canEdit={data.canEditTaxProfile} />

      <section className="space-y-3" aria-label="Discount rates">
        <h3 className="text-sm font-medium">Discount rates at {data.branchName}</h3>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3" data-testid="branch-row-senior">
          <div className="min-w-0">
            <p className="font-medium">Senior Citizen</p>
            <p className="text-xs text-muted-foreground">Set by law (RA 9994 §4(a)): exactly {STATUTORY_DISCOUNT_PERCENT}%, VAT-exempt, always on. Not editable.</p>
          </div>
          <span className="flex items-center gap-1 text-sm font-semibold tabular-nums">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {data.effective.senior_citizen.percentage}%
          </span>
        </div>

        <div className="space-y-2 rounded-md border p-3" data-testid="branch-row-pwd">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor={id('pwd')} className="font-medium">
                PWD
              </Label>
              <p className="text-xs text-muted-foreground">
                Required by law (RA 10754): at least {STATUTORY_DISCOUNT_PERCENT}%, VAT-exempt, always on. You may give more; you cannot give less or turn it off.
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Input
                id={id('pwd')}
                type="number"
                min={STATUTORY_DISCOUNT_PERCENT}
                max={100}
                step="0.01"
                className="w-20 text-right"
                value={form.pwdInherit ? String(data.organization.pwd.percentage) : form.pwd}
                disabled={disabled || form.pwdInherit}
                aria-invalid={pwdInvalid}
                aria-describedby={pwdInvalid ? id('pwd-error') : undefined}
                onChange={(e) => setForm((prev) => ({ ...prev, pwd: e.target.value }))}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={form.pwdInherit}
              disabled={disabled}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, pwdInherit: checked === true }))}
              aria-label="PWD uses the organization default"
            />
            Use the organization default ({data.organization.pwd.percentage}%)
          </label>
          {pwdInvalid && (
            <p id={id('pwd-error')} className="text-xs text-destructive">
              Enter {STATUTORY_DISCOUNT_PERCENT} to 100 (at most 2 decimals). The law does not allow less than {STATUTORY_DISCOUNT_PERCENT}%.
            </p>
          )}
        </div>

        {/* POS-PERF-P55 — statutoryOnly: the Employee rate and the required
            decision belong to the legacy checkout (manual peso discount types
            replace them in the new one). Their stored values are kept and
            re-sent unchanged on save, so older terminals keep behaving as before. */}
        {!statutoryOnly && (
        <div className="space-y-2 rounded-md border p-3" data-testid="branch-row-employee">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor={id('employee')} className="font-medium">
                Employee
              </Label>
              <p className="text-xs text-muted-foreground">Business choice. Comes off the price with VAT; VAT is charged on what remains (not VAT-exempt).</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id={id('employee-enabled')}
                  checked={employeeEnabled}
                  disabled={disabled || form.employeeInherit}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, employeeEnabled: checked }))}
                  aria-label="Employee discount enabled"
                />
                <span className="text-xs text-muted-foreground">{employeeEnabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div className="flex items-center gap-1">
                <Input
                  id={id('employee')}
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  className="w-20 text-right"
                  value={form.employeeInherit ? String(data.organization.employee.percentage) : form.employee}
                  disabled={disabled || form.employeeInherit}
                  aria-invalid={employeeInvalid}
                  aria-describedby={employeeInvalid ? id('employee-error') : undefined}
                  onChange={(e) => setForm((prev) => ({ ...prev, employee: e.target.value }))}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={form.employeeInherit}
              disabled={disabled}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, employeeInherit: checked === true }))}
              aria-label="Employee uses the organization default"
            />
            Use the organization default ({data.organization.employee.percentage}%, {data.organization.employee.isEnabled ? 'enabled' : 'disabled'})
          </label>
          {employeeInvalid && (
            <p id={id('employee-error')} className="text-xs text-destructive">
              Enter 0 to 100 (at most 2 decimals).
            </p>
          )}
        </div>
        )}

        {!statutoryOnly && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3" data-testid="branch-row-require-choice">
          <div className="min-w-0 max-w-prose">
            <Label htmlFor={id('require-choice')} className="font-medium">
              Cashier must choose a discount
            </Label>
            <p className="text-xs text-muted-foreground">
              Before charging, the cashier picks the discount that applies or &ldquo;No applicable discount&rdquo;. Nothing is applied automatically, and
              the cashier is never made to pick a discount the customer does not qualify for. Offline sales and older POS versions are not blocked by it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={id('require-choice')}
              checked={form.requireDiscountChoice}
              disabled={disabled}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, requireDiscountChoice: checked }))}
            />
            <span className="text-xs text-muted-foreground">{form.requireDiscountChoice ? 'Required' : 'Optional'}</span>
          </div>
        </div>
        )}
      </section>

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]" aria-label="Where each value comes from now">
        <dt className="text-muted-foreground">PWD now</dt>
        <dd>
          {data.effective.pwd.percentage}% · {SOURCE_LABELS[data.effective.pwd.source]}
        </dd>
        {!statutoryOnly && (
          <>
            <dt className="text-muted-foreground">Employee now</dt>
            <dd>
              {data.effective.employee.percentage}% ({data.effective.employee.isEnabled ? 'enabled' : 'disabled'}) · {SOURCE_LABELS[data.effective.employee.source]}
            </dd>
          </>
        )}
      </dl>

      {pwdValue !== null && employeeValue !== null && (
        <DiscountPreviewTable
          price={112}
          rates={{ pwd: pwdValue, senior_citizen: data.effective.senior_citizen.percentage, employee: employeeValue }}
          employeeEnabled={statutoryOnly ? false : employeeEnabled}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {statutoryOnly
          ? 'Other discounts are entered by the cashier as a peso amount, using the discount types above. Changes apply to new sales only; past sales keep the amounts they were rung with.'
          : 'Custom discounts (name, amount, products, schedule) are set up on the Discounts & Promotions page. Changes apply to new sales only; past sales keep the amounts they were rung with.'}
      </p>

      {conflict && (
        <p role="alert" className="text-sm text-destructive" data-testid="branch-discount-conflict">
          Someone else changed {data.branchName}&apos;s discounts after you opened them. The current values are shown now — check them, then make your change
          again.
        </p>
      )}
      {data.updatedAt && <p className="text-xs text-muted-foreground">Last changed for this branch {formatManilaDateTime(data.updatedAt)}</p>}

      {data.canEdit ? (
        <Button onClick={handleSave} disabled={!dirty || pwdInvalid || employeeInvalid || save.isPending}>
          {save.isPending ? 'Saving…' : `Save for ${data.branchName}`}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">You can view these settings but not change them.</p>
      )}
    </div>
  );
}
