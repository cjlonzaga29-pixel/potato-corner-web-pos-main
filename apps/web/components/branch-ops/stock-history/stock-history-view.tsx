'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InventoryApprovalQueue } from '@/components/branch-ops/inventory-approvals/inventory-approval-queue';
import { StockChangesView } from './stock-changes-view';

type StockHistoryTab = 'changes' | 'requests';

function StockHistoryContent({ basePath }: { basePath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab: StockHistoryTab = searchParams.get('tab') === 'requests' ? 'requests' : 'changes';

  function setTab(value: string) {
    router.replace(`${basePath}/inventory/stock-history${value === 'requests' ? '?tab=requests' : ''}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock History</h1>
        <p className="text-sm text-muted-foreground">
          Every applied stock change (Stock Changes) and the review status of every submitted request (Request History) — one place, reusing the same
          ledger and approval records shown elsewhere.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="changes">Stock Changes</TabsTrigger>
          <TabsTrigger value="requests">Request History</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="mt-4">
          <StockChangesView />
        </TabsContent>
        <TabsContent value="requests" className="mt-4">
          <InventoryApprovalQueue basePath={basePath} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Shared body behind `/branch/inventory/stock-history` and `/supervisor/inventory/stock-history`. */
export function StockHistoryView({ basePath }: { basePath: string }) {
  return (
    <Suspense>
      <StockHistoryContent basePath={basePath} />
    </Suspense>
  );
}
