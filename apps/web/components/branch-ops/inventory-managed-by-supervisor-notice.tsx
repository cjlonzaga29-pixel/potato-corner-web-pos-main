import { ClipboardCheck } from 'lucide-react';

/**
 * POS-PERF-P33 — rendered in place of every manual inventory page under
 * /branch/inventory/* except movements (Order Deductions, read-only — see
 * branch-sidebar.tsx). Inventory is now supervisor/admin-managed; a direct
 * URL or a stale tab lands here instead of the old form/list. This is a UX
 * courtesy only — the actual enforcement is server-side (every write
 * endpoint now requires adminOrSupervisor; see universal-inventory.router.ts
 * and inventory-approval.router.ts).
 */
export function InventoryManagedBySupervisorNotice() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-lg border bg-muted/30 px-6 py-16 text-center">
      <ClipboardCheck className="h-10 w-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Inventory is managed by your supervisor</h1>
      <p className="text-sm text-muted-foreground">
        Receiving, stock adjustments, waste, transfers, and stock history are now recorded by your branch&apos;s supervisor or an admin. You can still
        view automatic sale deductions under Order Deductions.
      </p>
    </div>
  );
}
