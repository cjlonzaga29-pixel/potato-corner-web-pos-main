import Link from 'next/link';
import { Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/feedback/empty-state';

/**
 * POS-PERF-P56 — what an old bookmark or link to /supervisor/cash lands on.
 * Only these pages are gone: no shift, cash record or endpoint changed, so
 * checkout, clock-in/out and the Admin and branch pages behave as before.
 */
export function CashManagementRemoved() {
  return (
    <div className="app-section">
      <EmptyState
        icon={Banknote}
        title="Cash Management has moved out of the Supervisor console"
        description="Sales records and cash reports are under Reports. Shift review is done by an Admin. No shift or cash record was changed or removed."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/supervisor/reports">Open Reports</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/supervisor/dashboard">Back to Dashboard</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
