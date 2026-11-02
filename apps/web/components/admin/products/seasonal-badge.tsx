import { Badge } from '@/components/ui/badge';

interface SeasonalBadgeProps {
  isSeasonal: boolean;
  /** POS-PERF-P58R — the product's actual type name, where one is known. */
  label?: string;
}

export function SeasonalBadge({ isSeasonal, label }: SeasonalBadgeProps) {
  return <Badge variant={isSeasonal ? 'warning' : 'secondary'}>{label ?? (isSeasonal ? 'Seasonal' : 'Regular')}</Badge>;
}
