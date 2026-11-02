'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { Banknote, TicketPercent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BranchDiscountSettingsSection } from '@/components/settings/branch-discount-settings-section';
import { LegacyDiscountSettings } from '@/components/settings/legacy-discount-settings';
import { TaxSettingsSection } from '@/components/settings/tax-settings-section';
import { BranchWorkHoursSection } from '@/components/settings/branch-work-hours-section';

/**
 * Task 209.xx — Supervisor's own Settings entry point. Not the full Admin
 * tab set (Security/Notifications/Receipts/Payments stay Super-Admin-only):
 * a Supervisor's write access is the discounts (POS-PERF-P50R: per branch
 * they manage, never organization-wide) and, since POS-PERF-P40, the Work
 * Hours of the branches they are assigned to.
 *
 * POS-PERF-P56 — statutory and legacy VAT settings collapsed, unchanged.
 * POS-PERF-P57 — Discount Types moved to the Discounts menu; linked from here.
 */
export default function SupervisorSettingsPage() {
  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">Discount types, work hours and payroll for the branches you manage.</p>
      </div>

      {/* useSelectedBranch reads search params, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <Card>
          <CardHeader className="gap-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
            <div className="min-w-0 space-y-1">
              <CardTitle>Discount types</CardTitle>
              <CardDescription>The discounts cashiers can choose from at checkout.</CardDescription>
            </div>
            <Button asChild variant="outline" className="min-h-10 w-full shrink-0 gap-2 sm:w-auto">
              <Link href="/supervisor/discounts">
                <TicketPercent className="h-4 w-4" aria-hidden="true" />
                Open Discounts
              </Link>
            </Button>
          </CardHeader>
        </Card>
        <BranchWorkHoursSection />
        <Card>
          <CardHeader className="gap-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
            <div className="min-w-0 space-y-1">
              <CardTitle>Payroll Settings</CardTitle>
              <CardDescription>Employee hourly rates, the pay period and how breaks are paid, per branch.</CardDescription>
            </div>
            <Button asChild variant="outline" className="min-h-10 w-full shrink-0 gap-2 sm:w-auto">
              <Link href="/supervisor/reports/payroll?tab=settings">
                <Banknote className="h-4 w-4" aria-hidden="true" />
                Open Payroll Settings
              </Link>
            </Button>
          </CardHeader>
        </Card>
        <LegacyDiscountSettings>
          <BranchDiscountSettingsSection statutoryOnly />
          <TaxSettingsSection />
        </LegacyDiscountSettings>
      </Suspense>
    </div>
  );
}
