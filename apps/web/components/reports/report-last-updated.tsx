import { Skeleton } from '@/components/ui/skeleton';
import { formatTimeAgo } from '@/lib/utils';
import { REPORT_CACHE_REFRESH_MINUTES } from '@/lib/constants';

export interface ReportLastUpdatedProps {
  timestamp: string | undefined;
  isLoading: boolean;
  label?: string;
}

export function ReportLastUpdated({ timestamp, isLoading, label = 'Last updated' }: ReportLastUpdatedProps) {
  if (isLoading) return <Skeleton className="h-4 w-40" />;
  if (!timestamp) return <p className="text-muted-foreground text-xs">Not yet computed</p>;

  return (
    <p className="text-muted-foreground text-xs">
      {label}: {formatTimeAgo(timestamp)}
      <span className="ml-1">(refreshes every {REPORT_CACHE_REFRESH_MINUTES} min)</span>
    </p>
  );
}
