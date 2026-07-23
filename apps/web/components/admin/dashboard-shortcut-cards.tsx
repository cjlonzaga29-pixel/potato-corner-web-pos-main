import Link from 'next/link';
import { ClipboardList, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Row 4 of the super admin dashboard — shortcuts to the full inventory and attendance views (both omitted from the dashboard itself). No data fetching. */
export function DashboardShortcutCards() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Link href="/admin/reports?tab=INVENTORY_VALUATION">
        <Card className="transition-colors hover:bg-accent/50">
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <ClipboardList className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Inventory Alerts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">View low and critical stock levels by branch</p>
          </CardContent>
        </Card>
      </Link>
      <Link href="/admin/attendance">
        <Card className="transition-colors hover:bg-accent/50">
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <Users className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Attendance</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">View staff clock-in records by branch</p>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}
