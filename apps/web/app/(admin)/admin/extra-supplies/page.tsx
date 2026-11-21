'use client';

import { Suspense } from 'react';
import { ExtraSupplyHistory } from '@/components/extra-supplies/extra-supply-history';
import { DashboardPageHeader } from '@/components/shared/dashboard/dashboard-page-header';

export default function AdminExtraSuppliesPage() {
  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader title="Extra Supplies" subtitle="Consolidated across branches, with a per-branch breakdown. Supervisors manage the cards." />
      {/* History reads a drill-through link's filters, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <ExtraSupplyHistory />
      </Suspense>
    </div>
  );
}
