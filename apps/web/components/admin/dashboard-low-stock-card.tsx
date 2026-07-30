import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

interface DashboardLowStockCardProps {
  totalItems: number | undefined;
  isLoading: boolean;
}

/** Super admin dashboard — total low-stock inventory items across accessible branches, with a shortcut into the full Inventory view. */
export function DashboardLowStockCard({ totalItems, isLoading }: DashboardLowStockCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Low Stock Inventory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div>
            <div className={`text-2xl font-bold ${(totalItems ?? 0) > 0 ? 'text-warning' : ''}`}>{totalItems ?? 0}</div>
            <p className="text-xs text-muted-foreground">Total items below reorder threshold</p>
          </div>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/inventory">View Inventory</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
