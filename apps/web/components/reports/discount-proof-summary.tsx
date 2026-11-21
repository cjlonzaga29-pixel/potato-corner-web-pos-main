'use client';

import { KpiCard } from '@/components/shared/charts/kpi-card';
import type { DiscountProofSummary as Summary } from '@/lib/discount-report';

function plural(count: number): string {
  return `${count} sale${count === 1 ? '' : 's'}`;
}

interface DiscountProofSummaryProps {
  summary: Summary;
  isLoading: boolean;
}

/**
 * POS-PERF-P59 — completion counts only sales whose saved record says proof was
 * required. With none, the figure is N/A rather than an invented 100%. Sales
 * where nothing saved says are stated apart, never counted as missing.
 */
export function DiscountProofSummary({ summary, isLoading }: DiscountProofSummaryProps) {
  const { required, available, missing, unknown, completionPercent } = summary;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4" data-testid="discount-proof-summary">
      <KpiCard title="Proof Required" value={required} isLoading={isLoading} caption={unknown > 0 ? `${plural(unknown)} with no saved requirement not counted` : undefined} />
      <KpiCard title="Proof Available" value={available} isLoading={isLoading} />
      <KpiCard title="Proof Missing" value={missing} isLoading={isLoading} tone={missing > 0 ? 'warning' : 'default'} />
      <KpiCard
        title="Proof Completion"
        value={completionPercent ?? 0}
        suffix="%"
        valueText={completionPercent === null ? 'N/A' : undefined}
        isLoading={isLoading}
        caption={completionPercent === null ? 'No sale here required proof' : `${available} of ${plural(required)} requiring proof`}
      />
    </div>
  );
}
