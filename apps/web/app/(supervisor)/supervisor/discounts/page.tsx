'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { ManualDiscountTypesSection } from '@/components/settings/manual-discount-types-section';

/** POS-PERF-P57 — the Discounts menu: the types cashiers choose from at checkout. Older promotions stay reachable, separately, for terminals not yet updated. */
export default function SupervisorDiscountsPage() {
  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="text-xl font-semibold">Discounts</h1>
        <p className="text-sm text-muted-foreground">The discount types cashiers can choose from at checkout, for the branches you manage.</p>
      </div>
      {/* useSelectedBranch reads search params, which needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <ManualDiscountTypesSection />
      </Suspense>
      <p className="text-sm text-muted-foreground">
        <Link href="/supervisor/promotions" className="underline">
          Legacy promotions
        </Link>{' '}
        only affect terminals still running an older POS version.
      </p>
    </div>
  );
}
