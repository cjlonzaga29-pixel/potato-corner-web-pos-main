'use client';

import { useState } from 'react';
import { AdminBranchSelect } from '@/components/admin/inventory/admin-branch-select';
import { InventoryMovementsView } from '@/components/branch-ops/inventory-movements-view';

/**
 * Admin-reachable counterpart to `/supervisor/inventory/movements` —
 * reuses that exact same InventoryMovementsView (same columns, filters,
 * pagination, proof viewing) rather than a parallel implementation, with an
 * explicit branch picker in place of the Supervisor/Branch chrome's
 * useBranchStore-driven "active branch". See branchGuard: super_admin has
 * unrestricted branch access, so any branch selected here is authorized.
 */
export default function AdminInventoryMovementsPage() {
  const [branchId, setBranchId] = useState<string | null>(null);

  return (
    <div className="app-section app-section-gap">
      <AdminBranchSelect branchId={branchId} onBranchChange={setBranchId} />
      {branchId ? (
        <InventoryMovementsView branchId={branchId} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a branch to view its inventory movements.</p>
      )}
    </div>
  );
}
