'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ExtraSuppliesSetup } from '@/components/extra-supplies/extra-supplies-setup';
import { ExtraSupplyHistory } from '@/components/extra-supplies/extra-supply-history';
import { DashboardPageHeader } from '@/components/shared/dashboard/dashboard-page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

function SupervisorExtraSupplies() {
  const search = useSearchParams();
  // A drill-through or a movement link carries filters, so it opens on History.
  const [tab, setTab] = useState(search.size > 0 ? 'history' : 'setup');
  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader title="Extra Supplies" subtitle="Additional cups, tissue and bags given free or sold separately." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Extra Supplies sections">
          <TabsTrigger value="setup">Supplies</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'setup' ? <ExtraSuppliesSetup /> : <ExtraSupplyHistory />}
    </div>
  );
}

export default function SupervisorExtraSuppliesPage() {
  return (
    // History reads a drill-through link's filters, which needs a Suspense boundary.
    <Suspense fallback={null}>
      <SupervisorExtraSupplies />
    </Suspense>
  );
}
