import { Info } from 'lucide-react';

interface ManagedElsewhereBannerProps {
  /** e.g. "Products", "Product Categories", "Universal Inventory" */
  module: string;
  /** e.g. "Supervisor" */
  managedBy: string;
}

/**
 * POS-PERF-P35 — placed at the top of every Admin catalog/inventory page
 * whose management moved to Supervisor. These pages stay read-only for
 * reporting; the banner makes that explicit instead of silently removing
 * buttons with no explanation.
 */
export function ManagedElsewhereBanner({ module, managedBy }: ManagedElsewhereBannerProps) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {module} is managed by {managedBy} now. This view is read-only for reporting.
      </span>
    </div>
  );
}
