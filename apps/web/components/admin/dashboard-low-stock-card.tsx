import Link from 'next/link';
import { PackageSearch } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DashboardLowStockCardProps {
  totalItems: number | undefined;
  isLoading: boolean;
}

/**
 * Super admin dashboard — action-oriented treatment for total low-stock
 * inventory items: a warning-toned icon chip when items need attention, and
 * the "View Inventory" shortcut promoted to a primary action so the card
 * reads as something to act on, not just a passive count.
 */
export function DashboardLowStockCard({ totalItems, isLoading }: DashboardLowStockCardProps) {
  const hasAlerts = (totalItems ?? 0) > 0;
  return (
    <Card className={cn(hasAlerts && 'border-warning/40')}>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
            hasAlerts ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground',
          )}
        >
          <PackageSearch className="h-4 w-4" />
        </div>
        <CardTitle className="text-sm font-medium">Low Stock Inventory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div>
            <div className={cn('text-2xl font-bold tabular-nums', hasAlerts && 'text-warning')}>{totalItems ?? 0}</div>
            <p className="text-xs text-muted-foreground">Total items below reorder threshold</p>
          </div>
        )}
        <Button asChild variant={hasAlerts ? 'default' : 'outline'} size="sm">
          <Link href="/admin/inventory">View Inventory</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
