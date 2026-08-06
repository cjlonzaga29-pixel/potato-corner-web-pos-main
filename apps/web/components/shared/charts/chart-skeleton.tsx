'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useDensityMode } from '@/hooks/use-density-mode';
import { DENSITY_CHART_HEIGHT } from '@/lib/density-tokens';

interface ChartSkeletonProps {
  /** Overrides the density-resolved height — pass the same explicit `height` given to the chart this skeleton stands in for. */
  height?: number;
  className?: string;
}

/**
 * Loading placeholder for chart cards, sized to the exact height
 * AreaChart/BarChart/LineChart/DonutChart resolve via DENSITY_CHART_HEIGHT
 * for the current density mode. Callers that previously used a bare
 * `<Skeleton className="h-[300px] w-full" />` caused a layout shift the
 * moment real data replaced the skeleton on any density mode other than
 * "comfortable" (280px) — compact resolves to 190px, mobile to 200px, etc.
 * Using this component keeps the loading → loaded transition height-stable
 * (Task 200 Phase 5/12 requirement).
 */
export function ChartSkeleton({ height, className }: ChartSkeletonProps) {
  const densityMode = useDensityMode();
  const resolvedHeight = height ?? DENSITY_CHART_HEIGHT[densityMode];
  return <Skeleton className={className ?? 'w-full'} style={{ height: resolvedHeight }} />;
}
