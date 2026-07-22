import type { LucideIcon } from 'lucide-react';
import { ArrowDown, ArrowUp, Info, Minus } from 'lucide-react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
  /** Visual emphasis for counts that need to stand out from a plain number (e.g. pending approvals, flagged shifts). Defaults to no emphasis. */
  tone?: 'default' | 'warning' | 'danger' | 'positive' | 'negative';
  /** Explanatory text shown via an info icon + tooltip next to the title (e.g. spelling out a derived KPI's formula). */
  tooltip?: string;
}

const TREND_ICONS = { up: ArrowUp, down: ArrowDown, neutral: Minus } as const;
const TREND_COLORS = {
  up: 'text-green-600 dark:text-green-400',
  down: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted-foreground',
} as const;
const TONE_BORDER = {
  default: '',
  warning: 'border-yellow-300 dark:border-yellow-800',
  danger: 'border-red-300 dark:border-red-800',
  positive: 'border-green-300 dark:border-green-800',
  negative: 'border-red-300 dark:border-red-800',
} as const;
const TONE_TEXT = {
  default: '',
  warning: 'text-yellow-700 dark:text-yellow-500',
  danger: 'text-red-700 dark:text-red-500',
  positive: 'text-green-700 dark:text-green-500',
  negative: 'text-red-700 dark:text-red-500',
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
  tone = 'default',
  tooltip,
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
    <Card className={cn(tone !== 'default' && `border-2 ${TONE_BORDER[tone]}`)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          {title}
          {tooltip && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 cursor-default" />
                </TooltipTrigger>
                <TooltipContent>{tooltip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-bold', TONE_TEXT[tone])}>
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
