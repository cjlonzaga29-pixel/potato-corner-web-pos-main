import { Badge } from '@/components/ui/badge';

interface SeasonalBadgeProps {
  isSeasonal: boolean;
}

export function SeasonalBadge({ isSeasonal }: SeasonalBadgeProps) {
  return <Badge variant={isSeasonal ? 'warning' : 'secondary'}>{isSeasonal ? 'Seasonal' : 'Regular'}</Badge>;
}
