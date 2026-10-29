'use client';

import { Suspense } from 'react';
import { InventoryList } from '@/components/branch-ops/inventory-list';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';

// POS-PERF-P47 — InventoryList reads `?status=` (dashboard card links) via
// useSearchParams, which Next requires to sit under a Suspense boundary.
export default function SupervisorInventoryPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <InventoryList basePath="/supervisor" />
    </Suspense>
  );
}
