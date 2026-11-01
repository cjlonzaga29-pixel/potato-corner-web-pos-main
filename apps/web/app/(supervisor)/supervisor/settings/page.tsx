'use client';

import { Suspense } from 'react';
import { BranchDiscountSettingsSection } from '@/components/settings/branch-discount-settings-section';
import { ManualDiscountTypesSection } from '@/components/settings/manual-discount-types-section';
import { TaxSettingsSection } from '@/components/settings/tax-settings-section';
import { BranchWorkHoursSection } from '@/components/settings/branch-work-hours-section';

/**
 * Task 209.xx — Supervisor's own Settings entry point. Not the full Admin
 * tab set (Security/Notifications/Receipts/Payments stay Super-Admin-only):
 * a Supervisor's write access is the discounts (POS-PERF-P50R: per branch
 * they manage, never organization-wide) and, since POS-PERF-P40, the Work
 * Hours of the branches they are assigned to.
 */
export default function SupervisorSettingsPage() {
  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">Discounts, VAT registration and work hours for the branches you manage.</p>
      </div>

      <TaxSettingsSection />
      {/* useSelectedBranch reads search params, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        {/* POS-PERF-P55 — discount types replace the Employee rate and the
            required-decision switch; the statutory PWD/Senior rows stay. */}
        <ManualDiscountTypesSection />
        <BranchDiscountSettingsSection statutoryOnly />
        <BranchWorkHoursSection />
      </Suspense>
    </div>
  );
}
