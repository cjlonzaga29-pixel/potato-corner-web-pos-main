import { InventoryManagedBySupervisorNotice } from '@/components/branch-ops/inventory-managed-by-supervisor-notice';

/** POS-PERF-P33 — this legacy URL (formerly a redirect into Stock History's "Request History" tab) now shows the same notice as every other removed manual inventory page for the Branch Account. */
export default function BranchInventoryApprovalsPage() {
  return <InventoryManagedBySupervisorNotice />;
}
