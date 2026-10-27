'use client';

import { Suspense } from 'react';
import { DiscountSettingsSection } from '@/components/settings/discount-settings-section';
import { BranchWorkHoursSection } from '@/components/settings/branch-work-hours-section';

/**
 * Task 209.xx — Supervisor's own Settings entry point. Not the full Admin
 * tab set (Security/Notifications/Receipts/Payments stay Super-Admin-only):
 * a Supervisor's write access is the discount percentages and, since
 * POS-PERF-P40, the Work Hours of the branches they are assigned to.
 */
export default function SupervisorSettingsPage() {
  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">POS discount percentages and your branches&apos; work hours.</p>
      </div>

      <DiscountSettingsSection />
      {/* useSelectedBranch reads search params, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <BranchWorkHoursSection />
      </Suspense>
    </div>
  );
}
