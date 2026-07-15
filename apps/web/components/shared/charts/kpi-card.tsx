import type { LucideIcon } from 'lucide-react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { calculatePercentageChange, cn } from '@/lib/utils';

interface KpiCardProps {
  title: string;
  value: number;
  previousValue?: number;
  prefix?: string;
  suffix?: string;
  trend?: 'up' | 'down' | 'neutral';
  trendLabel?: string;
  isLoading?: boolean;
  icon?: LucideIcon;
}

const TREND_ICONS = { up: ArrowUp, down: ArrowDown, neutral: Minus } as const;
const TREND_COLORS = {
  up: 'text-green-600 dark:text-green-400',
  down: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted-foreground',
} as const;

/**
 * Admin/supervisor dashboards only — animates via Magic UI's number ticker
 * on mount. Never used in the POS terminal (locked design system rule:
 * Magic UI is dashboard-only).
 */
export function KpiCard({
  title,
  value,
  previousValue,
  prefix,
  suffix,
  trend,
  trendLabel,
  isLoading,
  icon: Icon,
}: KpiCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <Skeleton className="h-4 w-24" />
          {Icon && <Skeleton className="h-4 w-4 rounded-full" />}
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-32" />
        </CardContent>
      </Card>
    );
  }

  const resolvedTrend =
    trend ?? (previousValue !== undefined ? (value > previousValue ? 'up' : value < previousValue ? 'down' : 'neutral') : undefined);
  const TrendIcon = resolvedTrend ? TREND_ICONS[resolvedTrend] : null;
  const percentageChange = previousValue !== undefined ? calculatePercentageChange(value, previousValue) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {prefix}
          <NumberTicker value={value} decimalPlaces={Number.isInteger(value) ? 0 : 2} className="text-inherit" />
          {suffix}
        </div>
        {resolvedTrend && TrendIcon && (
          <p className={cn('mt-1 flex items-center gap-1 text-xs', TREND_COLORS[resolvedTrend])}>
            <TrendIcon className="h-3 w-3" />
            {percentageChange !== null && `${Math.abs(percentageChange).toFixed(1)}%`}
            {trendLabel && <span className="text-muted-foreground">{trendLabel}</span>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
