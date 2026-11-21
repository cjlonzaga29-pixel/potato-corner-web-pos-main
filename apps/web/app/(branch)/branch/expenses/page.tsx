'use client';

import { Suspense } from 'react';
import { ExpensesView } from '@/components/branch-ops/expenses-view';

export default function BranchExpensesPage() {
  return (
    // ExpensesView reads a drill-through link's filters, which needs a Suspense boundary.
    <Suspense fallback={null}>
      <ExpensesView />
    </Suspense>
  );
}
