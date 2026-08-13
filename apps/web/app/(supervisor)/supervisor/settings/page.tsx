'use client';

import { DiscountSettingsSection } from '@/components/settings/discount-settings-section';

/**
 * Task 209.xx — Supervisor's own Settings entry point. Deliberately just the
 * one section today (Discount Settings) rather than the full Admin tab set
 * (Security/Notifications/Receipts/Payments stay Super-Admin-only) — a
 * Supervisor's write access is scoped to the discount percentages only.
 */
export default function SupervisorSettingsPage() {
  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">Configure POS discount percentages.</p>
      </div>

      <DiscountSettingsSection />
    </div>
  );
}
