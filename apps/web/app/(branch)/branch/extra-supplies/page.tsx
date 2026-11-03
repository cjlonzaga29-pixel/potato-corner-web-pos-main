'use client';

import { Suspense } from 'react';
import { ExtraSupplyHistory } from '@/components/extra-supplies/extra-supply-history';
import { DashboardPageHeader } from '@/components/shared/dashboard/dashboard-page-header';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useAuth } from '@/hooks/use-auth';

export default function BranchExtraSuppliesPage() {
  const { user } = useAuth();
  const branchId = user?.branchIds?.[0];
  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader title="Extra Supplies" subtitle="What this branch issued and collected. Issue new supplies from the POS Terminal." />
      {branchId ? (
        // History reads a drill-through link's filters, which needs a Suspense boundary.
        <Suspense fallback={null}>
          <ExtraSupplyHistory fixedBranchId={branchId} />
        </Suspense>
      ) : (
        <EmptyState title="No branch assigned" description="Contact your supervisor to get staffed to a branch." />
      )}
    </div>
  );
}
