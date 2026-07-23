import Link from 'next/link';
import { Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Row 4 of the super admin dashboard — shortcut to the full attendance view (inventory is already covered live in the Operations section above). No data fetching. */
export function DashboardShortcutCards() {
  return (
    <Link href="/admin/attendance" className="block md:max-w-sm">
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
  );
}
