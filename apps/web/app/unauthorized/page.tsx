'use client';

import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { ROLE_DASHBOARDS, ROLE_LABELS } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';

export default function UnauthorizedPage() {
  const user = useAuthStore((state) => state.user);
  const dashboardPath = user ? ROLE_DASHBOARDS[user.role] : '/login';

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <CardTitle className="text-xl">Access denied</CardTitle>
          <CardDescription>You do not have permission to access this page.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {user && (
            <p className="text-sm text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{ROLE_LABELS[user.role]}</span>
            </p>
          )}
          <Button asChild className="w-full">
            <Link href={dashboardPath}>Go to my dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
