'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useActiveSessions, useRevokeSession, type SessionResponse } from '@/hooks/queries/use-sessions';

export function ActiveSessionsSection() {
  const { data: sessions, isLoading, isError } = useActiveSessions();
  const revokeSession = useRevokeSession();
  const [sessionToRevoke, setSessionToRevoke] = useState<SessionResponse | null>(null);

  async function handleConfirmRevoke() {
    if (!sessionToRevoke) return;
    await revokeSession.mutateAsync(sessionToRevoke.id);
    setSessionToRevoke(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Sessions</CardTitle>
        <CardDescription>Devices where you&apos;re currently signed in.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {isError && <p className="text-sm text-destructive">Failed to load active sessions.</p>}

        {!isLoading && !isError && sessions?.length === 0 && (
          <p className="text-sm text-muted-foreground">No other active sessions</p>
        )}

        {!isLoading &&
          !isError &&
          sessions?.map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{session.deviceLabel}</span>
                  {session.isCurrent && <Badge variant="secondary">This device</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Signed in {formatDistanceToNow(new Date(session.createdAt), { addSuffix: true })}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={session.isCurrent}
                onClick={() => setSessionToRevoke(session)}
              >
                Sign out
              </Button>
            </div>
          ))}
      </CardContent>

      <AlertDialog open={sessionToRevoke !== null} onOpenChange={(open) => !open && setSessionToRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This will end the session on {sessionToRevoke?.deviceLabel}. That device will need to sign in again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={revokeSession.isPending} onClick={() => void handleConfirmRevoke()}>
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
