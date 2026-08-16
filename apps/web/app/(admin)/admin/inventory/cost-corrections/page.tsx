'use client';

import { useState } from 'react';
import { AdminBranchSelect } from '@/components/admin/inventory/admin-branch-select';
import { InventoryCostCorrectionsView } from '@/components/branch-ops/inventory-cost-corrections-view';

/**
 * Admin-reachable counterpart to `/supervisor/inventory/cost-corrections` —
 * reuses that exact same InventoryCostCorrectionsView (read/audit only, same
 * RBAC as the backend's adminOrSupervisor guard) with an explicit branch
 * picker in place of the Supervisor/Branch chrome's useBranchStore-driven
 * "active branch". Does not expand cost-correction permissions — Admin was
 * already authorized server-side, this only adds a route that reaches it.
 */
export default function AdminInventoryCostCorrectionsPage() {
  const [branchId, setBranchId] = useState<string | null>(null);

  return (
    <div className="app-section app-section-gap">
      <AdminBranchSelect branchId={branchId} onBranchChange={setBranchId} />
      {branchId ? (
        <InventoryCostCorrectionsView branchId={branchId} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a branch to view its cost correction history.</p>
      )}
    </div>
  );
}
